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
