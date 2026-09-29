import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../../../../convex/_generated/api.js";
import type { Id } from "../../../../../../convex/_generated/dataModel.js";
import type { ConversationMessageRow, ConversationSummary } from "@blaster/core";

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
  media?: Array<{ url: string; contentType?: string; size?: number }>;
}

export type InboundRecordResult =
  | { status: "stored"; conversationId: string; messageId: string }
  | { status: "duplicate"; conversationId: string; messageId: string }
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
    return await client.mutation(api.conversations.recordInboundMessage, input);
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
    return await client.mutation(api.conversations.applyOutboundStatus, {
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
    return { status: "ok", rows: await client.query(api.conversations.listConversations, query) };
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
      rows: await client.query(api.conversations.conversationMessages, {
        conversationId: conversationId as Id<"conversations">,
        ...(limit ? { limit } : {}),
      }),
    };
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}
