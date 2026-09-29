import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  conversationPairKey,
  nextStatus,
  normalizePhoneNumber,
  peerFromPairKey,
} from "../packages/core/src/conversation/history/index";

/**
 * Conversation history: storage and the transaction boundary.
 *
 * The rules live in packages/core/src/conversation/history as pure functions
 * (pair keying, E.164 normalization, reading a Telnyx event). These functions
 * hold no judgement of their own beyond what the domain already decided: they
 * resolve a pair to a row, write the message, and keep the denormalized
 * summary in step with it, all in one transaction so a list can never show a
 * count that disagrees with the messages behind it.
 */

const PREVIEW_LENGTH = 120;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 200;
const MAX_MESSAGE_LIMIT = 500;

const clamp = (value: number | undefined, fallback: number, max: number): number =>
  Math.min(Math.max(value ?? fallback, 1), max);

const summaryOf = (row: Doc<"conversations">) => ({
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
type CampaignGroup =
  | { kind: "unassigned" }
  | { kind: "multiple"; campaigns: string[] }
  | { kind: "one"; campaignId: string; sequenceId: Id<"sequences"> };

async function campaignFor(
  ctx: QueryCtx,
  peerNumber: string,
  blasterNumber: string,
): Promise<CampaignGroup> {
  if (!peerNumber || !blasterNumber) return { kind: "unassigned" };
  const enrollments = await ctx.db
    .query("sequenceEnrollments")
    .withIndex("to", (q) => q.eq("to", peerNumber))
    .collect();

  const matches: Array<{ campaignId: string; sequenceId: Id<"sequences">; rank: number }> = [];
  for (const enrollment of enrollments) {
    // An enrollment whose recipient was never recorded in E.164 cannot be
    // matched to a conversation, and a stopped sequence is not sending now.
    if (enrollment.to !== peerNumber || enrollment.status === "opted-out") continue;
    const sequence = await ctx.db.get(enrollment.sequenceId);
    if (!sequence || sequence.fromNumber !== blasterNumber) continue;
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

/** Find the conversation for a pair, creating it on first contact. */
async function resolveConversation(
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

/**
 * Conversations, newest activity first, filtered the way the inbox asks.
 *
 * Two different indexes serve two different questions, and conflating them is
 * what makes an inbox slow: "everything, newest first" reads `latestMessageAt`,
 * while "just the threads for this number" reads `blasterNumber` and sorts in
 * memory. Both are bounded by the same limit.
 *
 * The campaign is resolved per conversation, so the returned order does not
 * depend on which thread happened to be looked at first, and a contact
 * enrolled in two campaigns reports `multiple` instead of being filed under
 * whichever one the query met first.
 */
export const listConversations = query({
  args: {
    limit: v.optional(v.number()),
    /** Only threads for this sending number, in E.164. */
    number: v.optional(v.string()),
    /** Only threads whose resolved campaign is this id. */
    campaign: v.optional(v.string()),
    /** Include the resolved campaign on each row. Off by default: it costs a
     * lookup per conversation, and a list view that does not group does not
     * need it. */
    withCampaign: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = clamp(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const blasterNumber = args.number ? normalizePhoneNumber(args.number) : null;

    const rows = blasterNumber
      ? await ctx.db
          .query("conversations")
          .withIndex("blasterNumber", (q) => q.eq("blasterNumber", blasterNumber))
          .collect()
      : await ctx.db
          .query("conversations")
          .withIndex("latestMessageAt", (q) => q)
          .order("desc")
          .take(limit);

    const summaries = rows
      .map(summaryOf)
      .sort((a, b) => b.latestMessageAt - a.latestMessageAt)
      .slice(0, limit);

    const withCampaigns = args.withCampaign === true || args.campaign !== undefined;
    type Row = ReturnType<typeof summaryOf> & {
      campaignId?: string | null;
      sequenceId?: Id<"sequences"> | null;
      campaignGroup?: CampaignGroup["kind"];
      candidateCampaignIds?: string[];
    };
    const resolved: Row[] = await Promise.all(
      summaries.map(async (summary): Promise<Row> => {
        if (!withCampaigns) return summary;
        const group = await campaignFor(ctx, summary.phoneNumber, summary.blasterNumber);
        return {
          ...summary,
          campaignId: group.kind === "one" ? group.campaignId : null,
          sequenceId: group.kind === "one" ? group.sequenceId : null,
          campaignGroup: group.kind,
          ...(group.kind === "multiple" ? { candidateCampaignIds: group.campaigns } : {}),
        };
      }),
    );

    const wanted = args.campaign;
    const filtered = wanted
      ? resolved.filter(
          (row) =>
            row.campaignId === wanted ||
            (row.campaignGroup === "multiple" && (row.candidateCampaignIds ?? []).includes(wanted)),
        )
      : resolved;

    return filtered;
  },
});

/** One thread, oldest message first, which is the order it was spoken in. */
export const conversationMessages = query({
  args: { conversationId: v.id("conversations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("conversation", (q) => q.eq("conversationId", args.conversationId))
      .take(clamp(args.limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT));
    return rows.map((row) => ({
      id: row._id,
      direction: row.direction,
      body: row.body,
      from: row.from,
      to: row.to,
      status: row.status,
      telnyxMessageId: row.telnyxMessageId ?? null,
      sentAt: row.sentAt,
      media: row.media ?? null,
    }));
  },
});

/** The conversation for a number, resolved without listing everything. */
export const conversationForNumber = query({
  args: { phoneNumber: v.string(), blasterNumber: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const peer = normalizePhoneNumber(args.phoneNumber);
    const blaster = normalizePhoneNumber(args.blasterNumber ?? "");
    if (!peer || !blaster) return null;
    const row = await ctx.db
      .query("conversations")
      .withIndex("pairKey", (q) => q.eq("pairKey", conversationPairKey(peer, blaster)))
      .unique();
    return row ? summaryOf(row) : null;
  },
});

/**
 * Store an inbound message.
 *
 * `providerEventId` is checked before anything is written, so a Telnyx retry
 * resolves to the row that already exists and reports `duplicate` rather than
 * writing a second copy of the same text into the thread. The check is first
 * because it is the only way this function can be called twice for one event.
 */
export const recordInboundMessage = mutation({
  args: {
    from: v.string(),
    to: v.string(),
    body: v.string(),
    telnyxMessageId: v.optional(v.string()),
    providerEventId: v.optional(v.string()),
    receivedAt: v.optional(v.number()),
    media: v.optional(
      v.array(
        v.object({
          url: v.string(),
          contentType: v.optional(v.string()),
          size: v.optional(v.number()),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    if (args.providerEventId) {
      const seen = await ctx.db
        .query("messages")
        .withIndex("providerEventId", (q) => q.eq("providerEventId", args.providerEventId!))
        .unique();
      if (seen) {
        return {
          status: "duplicate" as const,
          conversationId: seen.conversationId,
          messageId: seen._id,
        };
      }
    }

    const from = normalizePhoneNumber(args.from);
    const to = normalizePhoneNumber(args.to);
    const pairKey = conversationPairKey(from, to);
    // The Blaster number is the end that is not the peer; on a self-message
    // both ends are ours, and an empty value keeps the row honest about it.
    const blasterNumber = from === to ? "" : to;
    const phoneNumber = blasterNumber ? peerFromPairKey(pairKey, blasterNumber) : from;
    const sentAt = args.receivedAt ?? Date.now();

    const conversationId = await resolveConversation(ctx, pairKey, phoneNumber, blasterNumber);
    const messageId = await ctx.db.insert("messages", {
      conversationId,
      direction: "inbound",
      body: args.body,
      from,
      to,
      status: "received",
      ...(args.telnyxMessageId ? { telnyxMessageId: args.telnyxMessageId } : {}),
      ...(args.providerEventId ? { providerEventId: args.providerEventId } : {}),
      sentAt,
      ...(args.media && args.media.length > 0 ? { media: args.media } : {}),
    });

    const conversation = await ctx.db.get(conversationId);
    const count = (conversation?.messageCount ?? 0) + 1;
    // A redelivery carries the original timestamp, so the summary only moves
    // forward. Without this, an out-of-order retry would make a thread look
    // newer than the conversation it belongs to.
    if (sentAt >= (conversation?.latestMessageAt ?? 0)) {
      await ctx.db.patch(conversationId, {
        latestMessageAt: sentAt,
        latestDirection: "inbound",
        latestPreview: args.body.slice(0, PREVIEW_LENGTH),
        latestMessageId: messageId,
        messageCount: count,
      });
    } else {
      await ctx.db.patch(conversationId, { messageCount: count });
    }

    return { status: "stored" as const, conversationId, messageId };
  },
});

/**
 * Apply a delivery state to a stored outbound message.
 *
 * Identified by the Telnyx message id rather than a Convex id, because the
 * provider is what addresses a message in every event it sends. A redelivery
 * lands here again, and the precedence rule in conversation/history is what
 * keeps it from undoing a state that has already moved on.
 *
 * Returns `stale` rather than an error when the event is a regression, so a
 * duplicate delivery is a normal outcome to log and not a failure to retry.
 */
export const applyOutboundStatus = mutation({
  args: {
    telnyxMessageId: v.string(),
    status: v.string(),
    eventType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("telnyxMessageId", (q) => q.eq("telnyxMessageId", args.telnyxMessageId))
      .unique();
    if (!message) {
      return { status: "unknown-message" as const, messageId: null, stored: null };
    }
    // An inbound message also carries a Telnyx id, so the id alone does not
    // prove this event is about a message we sent. Only outbound rows advance.
    if (message.direction !== "outbound") {
      return { status: "not-outbound" as const, messageId: message._id, stored: message.status };
    }
    const advanced = nextStatus(message.status, args.status);
    if (!advanced) {
      return { status: "stale" as const, messageId: message._id, stored: message.status };
    }
    await ctx.db.patch(message._id, { status: advanced });
    return { status: "applied" as const, messageId: message._id, stored: advanced };
  },
});
