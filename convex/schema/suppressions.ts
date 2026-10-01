import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for durable, per-person contact suppression. */
export const suppressionTables = {
  /**
   * A person who must not be contacted, keyed on the E.164 peer.
   *
   * Keyed on the *person*, not on `(person, number)`, because a STOP is about
   * the human: rotating through a pool must not walk around it. The inbound
   * path is already number-agnostic (`stopEnrollmentsForPeer` stops every
   * enrollment for the peer whichever number received the reply), and this is
   * the durable form of the same fact.
   *
   * Additive over `sequenceEnrollments.status === "opted-out"`, never a
   * replacement: the enrollment status stops one enrollment, this stops the
   * person everywhere, and neither can see what the other sees. Only a
   * deterministic inbound opt-out writes a row, and only an explicit human
   * resolve lifts it — structurally, by deleting the row, so nothing can lift
   * it by accident.
   */
  suppressions: defineTable({
    /** The peer, E.164. */
    peer: v.string(),
    /** Why, for an operator reading the list. */
    reason: v.optional(v.string()),
    /** What created it. Only inbound opt-outs and humans write rows. */
    source: v.union(v.literal("inbound-opt-out"), v.literal("manual")),
    /** The conversation the opt-out arrived on, when there was one. */
    conversationId: v.optional(v.id("conversations")),
    createdAt: v.number(),
  })
    // The read is always "is this peer suppressed", so the index is the key.
    .index("peer", ["peer"])
    .index("createdAt", ["createdAt"]),
};
