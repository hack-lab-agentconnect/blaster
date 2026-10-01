import { internalMutation } from "../_generated/server.js";
import { v } from "convex/values";

/**
 * Deployment health and notification writes.
 *
 * Thin wrappers; see docs/convex-naming-conventions.md (rule R5).
 */

export const upsertMessagingProfile = internalMutation({
  args: {
    country: v.string(),
    profileId: v.string(),
    tenDlcCampaignId: v.optional(v.string()),
    alphaSender: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("messagingProfiles")
      .withIndex("country", (q) => q.eq("country", args.country))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        profileId: args.profileId,
        tenDlcCampaignId: args.tenDlcCampaignId,
        alphaSender: args.alphaSender,
        active: true,
      });
      return existing._id;
    }
    return ctx.db.insert("messagingProfiles", { ...args, active: true });
  },
});

/**
 * Record a delivered notification.
 *
 * The firing-set key is what makes this idempotent: a poller that computes
 * the same set twice inserts once, so an unchanged condition is not
 * re-announced on every cycle.
 */
export const recordNotification = internalMutation({
  args: {
    ruleId: v.string(),
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
    message: v.string(),
    stateKey: v.string(),
  },
  handler: async (ctx, args) => {
    const alreadyDelivered = await ctx.db
      .query("notifications")
      .withIndex("stateKey", (q) => q.eq("stateKey", args.stateKey))
      .first();
    if (alreadyDelivered) return { inserted: false, id: alreadyDelivered._id };
    const id = await ctx.db.insert("notifications", { ...args, deliveredAt: Date.now() });
    return { inserted: true, id };
  },
});
