import { internalMutation, mutation } from "../_generated/server.js";
import { v } from "convex/values";
import { phoneInput, type PhoneInput } from "./model.js";

/**
 * Phone-number writes.
 *
 * Thin wrappers over model.ts. See docs/convex-naming-conventions.md (rule R5).
 */

/** Insert or refresh one ledger row, keyed on the E.164 number. */
export const storePhoneNumber = internalMutation({
  args: { phone: phoneInput },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phone.phoneNumber))
      .unique();
    if (existing) {
      await ctx.db.patch("phoneNumbers", existing._id, { ...args.phone });
      return existing._id;
    }
    return ctx.db.insert("phoneNumbers", { ...args.phone });
  },
});

/** Record a messaging-profile assignment made via `PATCH /phone_numbers/:id`. */
export const setMessagingBinding = mutation({
  args: { phoneNumber: v.string(), messagingProfileId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
    if (!existing) throw new Error(`unknown phone number ${args.phoneNumber}`);
    await ctx.db.patch("phoneNumbers", existing._id, { messagingProfileId: args.messagingProfileId });
    return existing._id;
  },
});

/**
 * Load numbers from Twenty `agencyPhones` into Convex.
 * Accepts already-read Twenty rows so this mutation needs no Twenty key; the
 * API/CLI/MCP layer reads Twenty and passes the rows in.
 */
export const importTwentyPhones = mutation({
  args: { phones: v.array(phoneInput) },
  handler: async (ctx, args) => {
    let stored = 0;
    for (const phone of args.phones as PhoneInput[]) {
      if (!phone.phoneNumber) continue;
      const existing = await ctx.db
        .query("phoneNumbers")
        .withIndex("phoneNumber", (q) => q.eq("phoneNumber", phone.phoneNumber))
        .unique();
      if (existing) continue;
      await ctx.db.insert("phoneNumbers", { ...phone });
      stored += 1;
    }
    return { stored, skipped: args.phones.length - stored };
  },
});
