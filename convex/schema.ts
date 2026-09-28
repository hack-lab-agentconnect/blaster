import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Blaster's own tables.
 *
 * Twenty remains the system of record for leads, calls, and prospects, so none
 * of that is mirrored here. What Blaster owns is the state Twenty cannot
 * represent: which messaging profile a jurisdiction is registered against,
 * which notifications have already been delivered, and the cost ceiling each
 * discovery run is allowed to spend.
 */
export default defineSchema({
  /** A messaging profile registered for one jurisdiction. */
  messagingProfiles: defineTable({
    /** ISO alpha-2, or "DEFAULT" for the catch-all profile. */
    country: v.string(),
    /** Telnyx messaging profile id. */
    profileId: v.string(),
    /** 10DLC brand and campaign backing a US profile. */
    tenDlcCampaignId: v.optional(v.string()),
    /** Alphanumeric sender backing a non-US profile. */
    alphaSender: v.optional(v.string()),
    active: v.boolean(),
  })
    .index("country", ["country"]),

  /**
   * A notification that has been delivered, keyed by the firing set it
   * belonged to, so an unchanged set is not delivered twice.
   */
  notifications: defineTable({
    ruleId: v.string(),
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
    message: v.string(),
    /** Identity of the whole firing set at the time of delivery. */
    stateKey: v.string(),
    deliveredAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("stateKey", ["stateKey"])
    .index("deliveredAt", ["deliveredAt"]),

  /** Cost ceiling and outcome for one discovery run. */
  discoveryRuns: defineTable({
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    maxCostUsd: v.number(),
    spentUsd: v.optional(v.number()),
    prospectsFound: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("startedAt", ["startedAt"]),

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
    .index("campaignId", ["campaignId"]),

  /** One step of a sequence, ordered by `order`. */
  sequenceSteps: defineTable({
    sequenceId: v.id("sequences"),
    order: v.number(),
    text: v.string(),
    delayHours: v.number(),
    isStop: v.boolean(),
  })
    .index("sequenceId", ["sequenceId"]),

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
    .index("nextDueAt", ["nextDueAt"]),
});

