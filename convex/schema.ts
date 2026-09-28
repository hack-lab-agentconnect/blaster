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
});
