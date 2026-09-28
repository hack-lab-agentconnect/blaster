import { internalQuery, internalMutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import manifest from "../config/env-vars.json" with { type: "json" };

/**
 * Deployment health and messaging profile state.
 *
 * The environment manifest is imported rather than read from `process.env`,
 * so this runs identically on a deployment, in a test, and in a typecheck.
 * Presence is answered by a separate query because an HTTP action has no
 * access to the environment.
 */
export const envStatus = internalQuery({
  args: {},
  handler: async (): Promise<Record<string, { present: boolean; required: boolean }>> => {
    const status: Record<string, { present: boolean; required: boolean }> = {};
    for (const variable of manifest.vars) {
      status[variable.name] = {
        present: Boolean(process.env[variable.name]),
        required: variable.required,
      };
    }
    return status;
  },
});

/** The manifest itself, for a caller that wants names and descriptions. */
export const environment = query({
  args: {},
  handler: async () => manifest,
});

export const listMessagingProfiles = query({
  args: {},
  handler: async (ctx) => {
    const profiles = await ctx.db.query("messagingProfiles").collect();
    return profiles.sort((a, b) => a.country.localeCompare(b.country));
  },
});

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

export const listNotifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("notifications").order("desc").take(args.limit ?? 50);
    return rows;
  },
});
