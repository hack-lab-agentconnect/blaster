import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for deployment health and messaging-profile state. */
export const messagingTables = {
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
  }).index("country", ["country"]),

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
};
