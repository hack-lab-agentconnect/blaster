import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for conversation history. */
export const conversationTables = {
  /**
   * A conversation, keyed on the pair of numbers that define it.
   *
   * `pairKey` is the identity: the two E.164 numbers sorted and joined, so an
   * inbound event (peer in `from`) and the outbound send that follows it
   * (peer in `to`) resolve to the same row. A Telnyx message id is deliberately
   * not the key: it identifies one message, and keying on it would give every
   * message its own conversation.
   *
   * The summary fields exist so the list view is one indexed query rather than
   * a scan over every message. They are denormalized on purpose and updated in
   * the same transaction that writes the message, so they cannot drift.
   */
  conversations: defineTable({
    /** `sortedPeer|blasterNumber`, both E.164. */
    pairKey: v.string(),
    /** The other party, in E.164. */
    phoneNumber: v.string(),
    /** The Blaster number that reached them, in E.164. */
    blasterNumber: v.string(),
    /** Timestamp of the newest stored message, for ordering the list. */
    latestMessageAt: v.optional(v.number()),
    latestDirection: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
    /** Short prefix of the newest message body, for the list view. */
    latestPreview: v.optional(v.string()),
    messageCount: v.optional(v.number()),
    /** Telnyx message id of the newest message, for jumping straight to it. */
    latestMessageId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("pairKey", ["pairKey"])
    .index("latestMessageAt", ["latestMessageAt"])
    .index("phoneNumber", ["phoneNumber"])
    // The inbox is organised by the number we sent from, not by the peer, so
    // this is the index the list view actually queries. Pair lookup uses
    // pairKey and the "with this contact" view uses phoneNumber.
    //
    // latestMessageAt is the second field so the list reads as one ranged scan
    // newest-first and can `take(limit)` its page, instead of reading every
    // thread for the number and sorting in memory. That also means there is no
    // separate single-field blasterNumber index: this one answers a query that
    // constrains only blasterNumber, and a shorter index over its prefix would
    // return the same rows while every insert wrote another copy of the table.
    .index("blasterNumberLatestMessageAt", ["blasterNumber", "latestMessageAt"]),

  /**
   * One stored message, inbound or outbound.
   *
   * `providerEventId` is the dedupe key and is unique: Telnyx retries a
   * webhook up to three times, and a retry is the same event rather than a new
   * message. Uniqueness is enforced by the index plus an insert-time check, so
   * a redelivery resolves to the existing row instead of a second copy.
   */
  messages: defineTable({
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    body: v.string(),
    /** E.164 on both ends, whatever the provider reported. */
    from: v.string(),
    to: v.string(),
    /** `received` / `queued` / `sent` / `delivered` / `failed` / `undelivered`. */
    status: v.string(),
    telnyxMessageId: v.optional(v.string()),
    /** Telnyx webhook event id. Present on inbound; absent on a message Blaster sent. */
    providerEventId: v.optional(v.string()),
    sentAt: v.number(),
    media: v.optional(
      v.array(v.object({ url: v.string(), contentType: v.optional(v.string()), size: v.optional(v.number()) })),
    ),
  })
    .index("conversation", ["conversationId", "sentAt"])
    .index("providerEventId", ["providerEventId"])
    .index("telnyxMessageId", ["telnyxMessageId"])
    // Outbound sends by recipient and time, so the daily cap counts what this
    // deployment actually sent. Additive index: backfilled by Convex, no
    // migration, no existing query changes shape.
    .index("to", ["to", "sentAt"]),
};
