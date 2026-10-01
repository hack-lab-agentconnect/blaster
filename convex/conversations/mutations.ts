import { mutation } from "../_generated/server.js";
import { v } from "convex/values";
import {
  conversationPairKey,
  nextStatus,
  normalizePhoneNumber,
  peerFromPairKey,
} from "../../packages/core/src/conversation/history/index";
import { PREVIEW_LENGTH, resolveConversation } from "./model.js";
import { stopEnrollmentsForPeer } from "../sequence/model.js";
import { suppressPeer } from "../suppressions/model.js";

/**
 * Conversation writes.
 *
 * Thin wrappers over model.ts, plus the one cross-domain call this file owns:
 * an inbound message stops the peer's enrollments in the same transaction that
 * stores it. See docs/convex-naming-conventions.md (rule R5).
 */

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
    /**
     * True when the sender unsubscribed rather than merely replying. Decided by
     * the caller with the deterministic classifier, never guessed here: the
     * mutation records what it is told, and the classifier is the only place
     * that reads message text.
     */
    optedOut: v.optional(v.boolean()),
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
        // Returning here is also the notification dedupe. Telnyx redelivers, and
        // because the redelivery never reaches the code below it can neither
        // stop an enrollment twice nor tell a human about the same reply twice.
        return {
          status: "duplicate" as const,
          conversationId: seen.conversationId,
          messageId: seen._id,
          stoppedEnrollments: [],
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

    const conversation = await ctx.db.get("conversations", conversationId);
    const count = (conversation?.messageCount ?? 0) + 1;
    // A redelivery carries the original timestamp, so the summary only moves
    // forward. Without this, an out-of-order retry would make a thread look
    // newer than the conversation it belongs to.
    if (sentAt >= (conversation?.latestMessageAt ?? 0)) {
      await ctx.db.patch("conversations", conversationId, {
        latestMessageAt: sentAt,
        latestDirection: "inbound",
        latestPreview: args.body.slice(0, PREVIEW_LENGTH),
        latestMessageId: messageId,
        messageCount: count,
      });
    } else {
      await ctx.db.patch("conversations", conversationId, { messageCount: count });
    }

    // A reply ends the sequence. Same transaction as the store above, so the
    // message and the stop cannot disagree, and it is already deduped by the
    // providerEventId check. An opt-out stops harder: the status is terminal
    // and sticky, so no later run can re-enroll the prospect by accident.
    const stopStatus = args.optedOut === true ? ("opted-out" as const) : ("replied" as const);
    const stoppedEnrollments = await stopEnrollmentsForPeer(ctx, phoneNumber, sentAt, stopStatus);

    // A STOP is a fact about the person, not this enrollment: record the durable
    // suppression in the same transaction, so a sibling sequence sending from
    // another pool number cannot reach them either. Written here rather than by
    // the caller so the stored message, the enrollment stop, and the suppression
    // are one atomic fact.
    let suppressed = false;
    if (args.optedOut === true) {
      suppressed = await suppressPeer(ctx, phoneNumber, {
        source: "inbound-opt-out",
        reason: "inbound STOP",
        conversationId,
        now: sentAt,
      });
    }

    return { status: "stored" as const, conversationId, messageId, stoppedEnrollments, suppressed };
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
    await ctx.db.patch("messages", message._id, { status: advanced });
    return { status: "applied" as const, messageId: message._id, stored: advanced };
  },
});
