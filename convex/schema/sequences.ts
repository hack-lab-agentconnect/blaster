import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for message sequences and enrollment state. */
export const sequenceTables = {
  /**
   * A message sequence: a sending number, an optional campaign, a set of
   * options, and an ordered list of steps held in sequenceSteps.
   */
  sequences: defineTable({
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("completed"),
    ),
    /** Sending number in E.164. */
    fromNumber: v.string(),
    /** Profile bound to that number, which outranks the country rule. */
    numberProfileId: v.optional(v.string()),
    /** Twenty campaign this sequence belongs to. */
    campaignId: v.optional(v.string()),
    /** How many steps the sequence has, so a runner can size a batch. */
    stepCount: v.number(),
    options: v.object({
      stopOnReply: v.boolean(),
      respectDoNotContact: v.boolean(),
      requireProfileForCountry: v.boolean(),
      dailyCapPerRecipient: v.number(),
    }),
    createdAt: v.number(),
  })
    .index("status", ["status"])
    .index("campaignId", ["campaignId"])
    // Resolving a conversation's campaign means finding the sequence that sent
    // from this number, so the inbox's per-number grouping can start here.
    .index("fromNumber", ["fromNumber"]),

  /** One step of a sequence, ordered by `order`. */
  sequenceSteps: defineTable({
    sequenceId: v.id("sequences"),
    order: v.number(),
    text: v.string(),
    delayHours: v.number(),
    isStop: v.boolean(),
  }).index("sequenceId", ["sequenceId"]),

  /** A prospect enrolled in a sequence, with its position and next due time. */
  sequenceEnrollments: defineTable({
    sequenceId: v.id("sequences"),
    /** Twenty prospect id, so the workspace stays the system of record. */
    recipientId: v.string(),
    to: v.optional(v.string()),
    country: v.optional(v.string()),
    /** Index of the next step to consider. */
    cursor: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("replied"),
      v.literal("opted-out"),
      v.literal("completed"),
      v.literal("paused"),
    ),
    enrolledAt: v.number(),
    nextDueAt: v.optional(v.number()),
    lastSentAt: v.optional(v.number()),
    /** Set when a send was skipped, so an operator can see why. */
    lastSkipReason: v.optional(v.string()),
  })
    .index("sequenceId", ["sequenceId"])
    .index("status", ["status"])
    .index("nextDueAt", ["nextDueAt"])
    // E.164 recipient, matching the conversation's peer number. A thread can
    // exist before anyone enrolls the contact, so this resolves a campaign for
    // the threads that have one and returns nothing for the rest, which is the
    // honest answer rather than a guess.
    .index("to", ["to"]),
};
