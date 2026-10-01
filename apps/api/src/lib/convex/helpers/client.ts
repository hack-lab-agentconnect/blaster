import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../../convex/_generated/api.js";
import type { Id } from "../../../../../../convex/_generated/dataModel.js";
import type { ConversationMessageRow, ConversationSummary, PoolDetail, PoolNumberRow, PoolSummary, SequenceOption } from "@blaster/core";

/**
 * The API's Convex client.
 *
 * This is the one boundary the Hono surface did not previously have. It exists
 * because the Telnyx webhook arrives here, and a verified inbound event has to
 * reach the writer without an operator or a CLI in the loop. Every other route
 * still answers from Twenty or Telnyx directly, and still works with no
 * CONVEX_URL configured.
 *
 * Functions are referenced through the generated `api` module rather than by
 * name, so a renamed or deleted Convex function is a type error here instead of
 * a runtime 404 in production.
 */

let cached: { url: string; client: ConvexHttpClient } | null = null;

/** Null when CONVEX_URL is unset, so callers can degrade instead of crashing. */
export function convexClient(url: string | undefined = process.env.CONVEX_URL): ConvexHttpClient | null {
  const address = url?.trim();
  if (!address) return null;
  if (cached?.url === address) return cached.client;
  const client = new ConvexHttpClient(address);
  cached = { url: address, client };
  return client;
}

export interface InboundRecordInput {
  from: string;
  to: string;
  body: string;
  telnyxMessageId?: string;
  providerEventId?: string;
  receivedAt?: number;
  /**
   * True when the sender unsubscribed. Decided by the caller with the
   * deterministic classifier; the mutation records what it is told.
   */
  optedOut?: boolean;
  media?: Array<{ url: string; contentType?: string; size?: number }>;
}

/**
 * What a stored reply stopped.
 *
 * Carried out of Convex so the API can decide whether the reply is worth
 * notifying on. A duplicate reports an empty list, which is what makes the
 * providerEventId dedupe inside the mutation double as the notification dedupe.
 */
export interface StoppedEnrollment {
  enrollmentId: string;
  sequenceId: string;
  status: string;
  /** The responsible member, when one was recorded at enroll time. */
  ownerMemberId: string | null;
}

export type InboundRecordResult =
  | { status: "stored"; conversationId: string; messageId: string; stoppedEnrollments: StoppedEnrollment[] }
  | { status: "duplicate"; conversationId: string; messageId: string; stoppedEnrollments: StoppedEnrollment[] }
  | { status: "not-configured" }
  | { status: "failed"; error: string };

/**
 * Store a verified inbound message. Reports rather than throws, so the webhook
 * can answer 200 on a duplicate instead of triggering a retry storm for an event
 * that is already durably stored.
 */
export async function recordInboundMessage(input: InboundRecordInput): Promise<InboundRecordResult> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    return await client.mutation(api.conversations.mutations.recordInboundMessage, input);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export type StatusResult =
  | { status: "applied" | "stale" | "not-outbound"; messageId: string; stored: string }
  | { status: "unknown-message"; messageId: null; stored: null }
  | { status: "not-configured" }
  | { status: "failed"; error: string };

/** Apply a delivery state to a message we sent, subject to the rank rule. */
export async function applyOutboundStatus(
  telnyxMessageId: string,
  status: string,
  eventType?: string,
): Promise<StatusResult> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    return await client.mutation(api.conversations.mutations.applyOutboundStatus, {
      telnyxMessageId,
      status,
      ...(eventType ? { eventType } : {}),
    });
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The row shapes are the shared contract from `@blaster/core`, not a second
 * declaration of them. The CLI, MCP and the terminal client all import the same
 * types, so a field that moves breaks every surface at once instead of leaving
 * one of them reading a field that no longer exists.
 */
export type ConversationRow = ConversationSummary;
export type MessageRow = ConversationMessageRow;

export interface ConversationQuery {
  limit?: number;
  number?: string;
  campaign?: string;
  withCampaign?: boolean;
}

export type ReadResult<T> = { status: "ok"; rows: T[] } | { status: "not-configured" } | { status: "failed"; error: string };

/** Conversations, newest activity first, with the inbox filters applied. */
export async function listConversations(query: ConversationQuery = {}): Promise<ReadResult<ConversationRow>> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    return { status: "ok", rows: await client.query(api.conversations.queries.listConversations, query) };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * One thread, oldest message first.
 *
 * The id arrives from a URL, so it is a plain string here. Convex validates the
 * shape on the way in and answers a bad id with an argument error, which the
 * route turns into a 404 rather than a 502.
 */
export async function conversationMessages(
  conversationId: string,
  limit?: number,
): Promise<ReadResult<MessageRow>> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    return {
      status: "ok",
      rows: await client.query(api.conversations.queries.conversationMessages, {
        conversationId: conversationId as Id<"conversations">,
        ...(limit ? { limit } : {}),
      }),
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Pool reads and writes.
 *
 * The HTTP surface owns the pool contract: the CLI and MCP go through the
 * shared `BlasterApiClient`, which calls these routes, so all three surfaces
 * act on the same pool state. The Convex functions are the writers; this file
 * only adapts their documents to the shared shapes in `@blaster/core`.
 */

/** A pool result, in the shape the routes map onto status codes. */
export type PoolResult<T> =
  | { status: "ok"; value: T }
  | { status: "not-configured" }
  | { status: "failed"; error: string };

type ConvexPool = {
  _id: string;
  name: string;
  status: "active" | "paused";
  strategy: string;
  cursor: number;
  minSpacingMs: number;
  dailyCapPerNumber: number;
  activeNumberCount: number;
  nextAvailableAt: number;
  lastDispatchedAt?: number;
  createdAt: number;
};

type ConvexPoolNumber = {
  phoneNumberId: string;
  phoneNumber: string;
  order: number;
  status: "active" | "paused" | "removed";
  sentToday: number;
  nextAvailableAt: number;
  lastSentAt?: number;
  assignedAt: number;
  removedAt?: number;
};

function toPoolSummary(pool: ConvexPool): PoolSummary {
  return {
    id: pool._id,
    name: pool.name,
    status: pool.status,
    strategy: pool.strategy,
    cursor: pool.cursor,
    minSpacingMs: pool.minSpacingMs,
    dailyCapPerNumber: pool.dailyCapPerNumber,
    activeNumberCount: pool.activeNumberCount,
    nextAvailableAt: pool.nextAvailableAt,
    lastDispatchedAt: pool.lastDispatchedAt ?? null,
    createdAt: pool.createdAt,
  };
}

function toPoolNumber(row: ConvexPoolNumber): PoolNumberRow {
  return {
    phoneNumberId: row.phoneNumberId,
    phoneNumber: row.phoneNumber,
    order: row.order,
    status: row.status,
    sentToday: row.sentToday,
    nextAvailableAt: row.nextAvailableAt,
    lastSentAt: row.lastSentAt ?? null,
    assignedAt: row.assignedAt,
    removedAt: row.removedAt ?? null,
  };
}

function toPoolDetail(pool: ConvexPool & { numbers: ConvexPoolNumber[] }): PoolDetail {
  return { ...toPoolSummary(pool), numbers: pool.numbers.map(toPoolNumber) };
}

/** Wrap a Convex call so an unconfigured deployment degrades instead of throwing. */
async function poolCall<T>(call: () => Promise<T>): Promise<PoolResult<T>> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    return { status: "ok", value: await call() };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function listPools(): Promise<PoolResult<PoolSummary[]>> {
  return poolCall(async () => {
    const rows = await convexClient()!.query(api.pool.queries.listPools, {});
    return rows.map(toPoolSummary);
  });
}

export async function getPool(poolId: string): Promise<PoolResult<PoolDetail | null>> {
  return poolCall(async () => {
    const pool = await convexClient()!.query(api.pool.queries.getPool, {
      poolId: poolId as Id<"pools">,
    });
    return pool ? toPoolDetail(pool) : null;
  });
}

export async function createPool(input: {
  name: string;
  minSpacingMs?: number;
  dailyCapPerNumber?: number;
}): Promise<PoolResult<{ id: string }>> {
  return poolCall(async () => {
    const id = await convexClient()!.mutation(api.pool.mutations.createPool, {
      name: input.name,
      ...(input.minSpacingMs === undefined ? {} : { minSpacingMs: input.minSpacingMs }),
      ...(input.dailyCapPerNumber === undefined ? {} : { dailyCapPerNumber: input.dailyCapPerNumber }),
    });
    return { id };
  });
}

/** Add a number, then return the pool as it stands. */
export async function addPoolNumber(
  poolId: string,
  phoneNumber: string,
  order?: number,
): Promise<PoolResult<PoolDetail>> {
  return poolCall(async () => {
    await convexClient()!.mutation(api.pool.mutations.assignNumber, {
      poolId: poolId as Id<"pools">,
      phoneNumber,
      ...(order === undefined ? {} : { order }),
    });
    const pool = await convexClient()!.query(api.pool.queries.getPool, { poolId: poolId as Id<"pools"> });
    return toPoolDetail(pool!);
  });
}

export async function removePoolNumber(
  poolId: string,
  phoneNumber: string,
): Promise<PoolResult<PoolDetail>> {
  return poolCall(async () => {
    await convexClient()!.mutation(api.pool.mutations.removeNumber, {
      poolId: poolId as Id<"pools">,
      phoneNumber,
    });
    const pool = await convexClient()!.query(api.pool.queries.getPool, { poolId: poolId as Id<"pools"> });
    return toPoolDetail(pool!);
  });
}

export async function reorderPoolNumbers(
  poolId: string,
  order: string[],
): Promise<PoolResult<PoolDetail>> {
  return poolCall(async () => {
    await convexClient()!.mutation(api.pool.mutations.reorderNumbers, {
      poolId: poolId as Id<"pools">,
      order,
    });
    const pool = await convexClient()!.query(api.pool.queries.getPool, { poolId: poolId as Id<"pools"> });
    return toPoolDetail(pool!);
  });
}

export async function setSequencePool(
  sequenceId: string,
  poolId?: string,
): Promise<PoolResult<{ sequenceId: string }>> {
  return poolCall(async () => {
    const id = await convexClient()!.mutation(api.sequence.mutations.setSequencePool, {
      sequenceId: sequenceId as Id<"sequences">,
      ...(poolId === undefined ? {} : { poolId: poolId as Id<"pools"> }),
    });
    return { sequenceId: id };
  });
}

/** Sequences, newest first, for a pool-assignment picker. */
export async function listSequences(): Promise<PoolResult<SequenceOption[]>> {
  return poolCall(async () => {
    const rows = await convexClient()!.query(api.sequence.queries.listSequences, {});
    return rows.map((row) => ({
      id: row._id,
      name: row.name,
      status: row.status,
      poolId: row.poolId ?? null,
    }));
  });
}

/** One row of the Convex phone ledger, as the ownership check reads it. */
export interface LedgerNumber {
  phoneNumber: string;
  telnyxNumberId?: string;
  messagingProfileId?: string;
  status?: string;
}

/**
 * The deployment's own purchase ledger.
 *
 * The third ownership registry, alongside the Telnyx account and the Twenty
 * mirror. It matters for an inbound event addressed to a number that is owned
 * but not yet visible in either of the others: a number bought through the
 * Convex `phoneNumbers` action, or one a pool added that had no ledger row until
 * then. Without this source those replies would be refused as not-owned and
 * dropped.
 */
export async function listLedgerNumbers(): Promise<ReadResult<LedgerNumber>> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    const rows = await client.query(api.phoneNumbers.queries.listPhoneNumbers, {});
    return {
      status: "ok",
      rows: rows.map((row) => ({
        phoneNumber: row.phoneNumber,
        ...(row.telnyxNumberId ? { telnyxNumberId: row.telnyxNumberId } : {}),
        ...(row.messagingProfileId ? { messagingProfileId: row.messagingProfileId } : {}),
        ...(row.status ? { status: row.status } : {}),
      })),
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** One suppression row, as the operator list reads it. */
export interface SuppressionRow {
  peer: string;
  reason?: string;
  source: "inbound-opt-out" | "manual";
  createdAt: number;
}

/**
 * Everyone currently suppressed, newest first.
 *
 * The durable per-person suppression list — a STOP recorded once, holding across
 * sequences and pool numbers. Operator-facing, so it is read through the same
 * operator-gated surface as the pool list.
 */
export async function listSuppressions(): Promise<ReadResult<SuppressionRow>> {
  const client = convexClient();
  if (!client) return { status: "not-configured" };
  try {
    const rows = await client.query(api.suppressions.mutations.listSuppressions, {});
    return {
      status: "ok",
      rows: rows.map((row) => ({
        peer: row.peer,
        ...(row.reason ? { reason: row.reason } : {}),
        source: row.source,
        createdAt: row.createdAt,
      })),
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Record a suppression by hand, or lift one. Both operator actions. */
export async function setSuppression(
  peer: string,
  suppressed: boolean,
  reason?: string,
): Promise<PoolResult<{ peer: string; changed: boolean }>> {
  return poolCall(async () => {
    if (suppressed) {
      const result = await convexClient()!.mutation(api.suppressions.mutations.suppress, {
        peer,
        source: "manual",
        ...(reason ? { reason } : {}),
      });
      return { peer: result.peer, changed: result.created };
    }
    const result = await convexClient()!.mutation(api.suppressions.mutations.lift, { peer });
    return { peer: result.peer, changed: result.lifted };
  });
}

/**
 * Enroll prospects straight from Twenty, reusing the send filter DSL.
 *
 * The action walks `agencyProspects` on the Convex side (it has the Twenty
 * credentials there), so this is a single call the API/CLI/MCP surfaces share
 * rather than each re-implementing the walk. Returns per-prospect outcomes so a
 * caller sees who was enrolled and who was skipped, and why.
 */
export interface EnrollOutcome {
  prospectId: string;
  phone: string | null;
  status: "enrolled" | "skipped";
  detail: string | null;
}

export async function enrollRecipients(input: {
  sequenceId: string;
  filters: Array<{ field: string; operator: string; value?: string | number | boolean | string[] }>;
  ownerMemberId?: string;
  outboundState?: string;
}): Promise<PoolResult<{ total: number; enrolled: number; skipped: number; outcomes: EnrollOutcome[] }>> {
  return poolCall(async () => {
    return convexClient()!.action(api.sequence.actions.enrollRecipients, {
      sequenceId: input.sequenceId as never,
      filters: input.filters as never,
      ...(input.ownerMemberId === undefined ? {} : { ownerMemberId: input.ownerMemberId }),
      ...(input.outboundState === undefined ? {} : { outboundState: input.outboundState }),
    });
  });
}
