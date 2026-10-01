import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { poolContainsNumber } from "../pool/helpers.js";
import {
  conversationPairKey,
  normalizePhoneNumber,
  peerFromPairKey,
} from "../../packages/core/src/conversation/history/index";

/**
 * Conversation storage helpers.
 *
 * Context-bound logic shared by this domain's queries and mutations: each
 * function takes a ctx, calls core pure helpers to decide, and performs the
 * reads and writes. No Convex function wrapper lives here, so nothing in this
 * file is an API address on its own.
 */

export const PREVIEW_LENGTH = 120;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_MESSAGE_LIMIT = 200;
export const MAX_MESSAGE_LIMIT = 500;

export const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(value ?? fallback, 1), max);

export const summaryOf = (row: Doc<"conversations">) => ({
  id: row._id,
  phoneNumber: row.phoneNumber,
  blasterNumber: row.blasterNumber,
  latestMessageAt: row.latestMessageAt ?? row.createdAt,
  latestDirection: row.latestDirection ?? null,
  latestPreview: row.latestPreview ?? null,
  messageCount: row.messageCount ?? 0,
  latestMessageId: row.latestMessageId ?? null,
});

/**
 * Which campaign a conversation belongs to, and when that is ambiguous.
 *
 * A contact can be enrolled in several sequences that all send from the same
 * number, so "the campaign" is not always a single value. Silently taking the
 * first row the query happens to return would make the inbox regroup itself
 * between calls, so ambiguity is reported instead:
 *
 *   - no enrollment for this peer and number -> `unassigned`
 *   - enrollments spanning more than one campaign -> `multiple`
 *   - otherwise the most recent enrollment's campaign wins, with the Convex
 *     creation time as the tie-break, which is total and stable.
 *
 * Returned per conversation so the client can show a thread as ambiguous
 * rather than inventing a group for it.
 */
export type CampaignGroup =
  | { kind: "unassigned" }
  | { kind: "multiple"; campaigns: string[] }
  | { kind: "one"; campaignId: string; sequenceId: Id<"sequences"> };

export async function campaignFor(
  ctx: QueryCtx,
  peerNumber: string,
  blasterNumber: string,
): Promise<CampaignGroup> {
  if (!peerNumber || !blasterNumber) return { kind: "unassigned" };
  // One contact's enrollments, matched on the E.164 `to` column. A contact is
  // enrolled per campaign, so this is a handful of rows. A page would answer a
  // question this call is not asking: it reports ambiguity across all of them.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const enrollments = await ctx.db
    .query("sequenceEnrollments")
    .withIndex("to", (q) => q.eq("to", peerNumber))
    .collect();

  const matches: Array<{ campaignId: string; sequenceId: Id<"sequences">; rank: number }> = [];
  for (const enrollment of enrollments) {
    // An enrollment whose recipient was never recorded in E.164 cannot be
    // matched to a conversation, and a stopped sequence is not sending now.
    if (enrollment.to !== peerNumber || enrollment.status === "opted-out") continue;
    const sequence = await ctx.db.get("sequences", enrollment.sequenceId);
    if (!sequence) continue;
    // A sequence sends from its fixed `fromNumber`, or, when a pool is assigned,
    // from whichever number the pool chose. Matching on `fromNumber` alone would
    // leave every pool-backed thread `unassigned`, so a pool sequence also
    // matches when the thread's blaster number is a member of its pool.
    const usesNumber =
      sequence.fromNumber === blasterNumber ||
      (sequence.poolId ? await poolContainsNumber(ctx, sequence.poolId, blasterNumber) : false);
    if (!usesNumber) continue;
    if (!sequence.campaignId) continue;
    matches.push({
      campaignId: sequence.campaignId,
      sequenceId: sequence._id,
      rank: (enrollment.enrolledAt ?? 0) * 1000 + (enrollment._creationTime % 1000),
    });
  }
  if (matches.length === 0) return { kind: "unassigned" };

  const campaigns = [...new Set(matches.map((m) => m.campaignId))];
  if (campaigns.length > 1) return { kind: "multiple", campaigns: campaigns.sort() };
  const winner = matches.reduce((best, m) => (m.rank > best.rank ? m : best));
  return { kind: "one", campaignId: winner.campaignId, sequenceId: winner.sequenceId };
}

export const OUTBOUND_PREVIEW_LENGTH = 120;

/**
 * Store a message Blaster sent, with the same summary discipline as the
 * inbound path: the row, the count, and the preview move together or not at
 * all. Callers pass what the provider confirmed; this function never sends.
 */
export async function recordOutboundRow(
  ctx: MutationCtx,
  message: {
    to: string;
    from: string;
    text: string;
    telnyxMessageId: string;
    sentAt: number;
  },
): Promise<{ conversationId: unknown; messageId: unknown }> {
  const from = normalizePhoneNumber(message.from);
  const to = normalizePhoneNumber(message.to);
  const pairKey = conversationPairKey(from, to);
  const blasterNumber = from === to ? "" : from;
  const phoneNumber = blasterNumber ? peerFromPairKey(pairKey, blasterNumber) : to;
  const conversationId = await resolveConversation(ctx, pairKey, phoneNumber, blasterNumber);
  const messageId = await ctx.db.insert("messages", {
    conversationId,
    direction: "outbound",
    body: message.text,
    from,
    to,
    status: "sent",
    telnyxMessageId: message.telnyxMessageId,
    sentAt: message.sentAt,
  });
  const conversation = await ctx.db.get("conversations", conversationId);
  const count = ((conversation as { messageCount?: number } | null)?.messageCount ?? 0) + 1;
  await ctx.db.patch("conversations", conversationId, {
    latestMessageAt: message.sentAt,
    latestDirection: "outbound",
    latestPreview: message.text.slice(0, OUTBOUND_PREVIEW_LENGTH),
    latestMessageId: messageId,
    messageCount: count,
  });
  return { conversationId, messageId };
}

/** Find the conversation for a pair, creating it on first contact. */
export async function resolveConversation(
  ctx: MutationCtx,
  pairKey: string,
  phoneNumber: string,
  blasterNumber: string,
): Promise<Id<"conversations">> {
  const existing = await ctx.db
    .query("conversations")
    .withIndex("pairKey", (q) => q.eq("pairKey", pairKey))
    .unique();
  if (existing) return existing._id;
  return ctx.db.insert("conversations", { pairKey, phoneNumber, blasterNumber, createdAt: Date.now() });
}
