import { query } from "../_generated/server.js";
import { v } from "convex/values";

/**
 * Phone-number reads.
 *
 * Thin wrappers over model.ts. See docs/convex-naming-conventions.md (rule R5).
 */

export const listPhoneNumbers = query({
  args: {},
  handler: async (ctx) => {
    // phoneNumbers is a bounded config table: one row per number this
    // deployment bought, so every caller of this list is asking for all of them.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const rows = await ctx.db.query("phoneNumbers").collect();
    return rows.sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
  },
});

export const getPhoneNumber = query({
  args: { phoneNumber: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
  },
});
