import { query } from "../_generated/server.js";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel.js";
import {
  conversationPairKey,
  normalizePhoneNumber,
} from "../../packages/core/src/conversation/history/index";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MESSAGE_LIMIT,
  MAX_LIST_LIMIT,
  MAX_MESSAGE_LIMIT,
  campaignFor,
  clamp,
  summaryOf,
  type CampaignGroup,
} from "./model.js";

/**
 * Conversation reads.
 *
 * Thin wrappers over model.ts: validate args, call one model function, return.
 * See docs/convex-naming-conventions.md (rule R5).
 */

/**
 * Conversations, newest activity first, filtered the way the inbox asks.
 *
 * Two different indexes serve two different questions, and conflating them is
 * what makes an inbox slow: "everything, newest first" reads `latestMessageAt`,
 * while "just the threads for this number" reads `blasterNumber` then
 * `latestMessageAt`. Both are ordered by the index and capped at `limit`, so
 * neither reads more threads than the page it returns.
 *
 * The re-sort below is over `limit` rows and exists because `latestMessageAt` is
 * optional: a thread with no stored timestamp yet sorts on `createdAt` instead,
 * and the index cannot know that. It decides the order among rows the index
 * already narrowed, rather than choosing which rows to read.
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
          .withIndex("blasterNumberLatestMessageAt", (q) =>
            q.eq("blasterNumber", blasterNumber),
          )
          .order("desc")
          .take(limit)
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
