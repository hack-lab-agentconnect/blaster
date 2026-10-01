import { internalQuery, query } from "../_generated/server.js";
import { v } from "convex/values";
import manifest from "../../config/env-vars.json" with { type: "json" };

/**
 * Deployment health and messaging profile reads.
 *
 * Thin wrappers; see docs/convex-naming-conventions.md (rule R5). The
 * environment manifest is imported rather than read from `process.env`, so
 * this runs identically on a deployment, in a test, and in a typecheck.
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

export const listNotifications = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("notifications").order("desc").take(args.limit ?? 50);
    return rows;
  },
});
