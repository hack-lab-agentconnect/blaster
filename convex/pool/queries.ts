import { internalQuery, query } from "../_generated/server.js";
import { v } from "convex/values";
import { availableSender as readAvailableSender, membersOf } from "./helpers.js";
import { DEFAULT_LIST_LIMIT } from "./utils.js";

/**
 * Pool reads.
 *
 * Thin wrappers over model.ts and helpers.ts. See
 * docs/convex-naming-conventions.md (rule R5).
 */

/** Pools, newest first. A bounded config table, so the whole set is the answer. */
export const listPools = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const rows = await ctx.db.query("pools").collect();
    return rows
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, args.limit ?? DEFAULT_LIST_LIMIT);
  },
});

/** One pool with its memberships in order, which is what a status view needs. */
export const getPool = query({
  args: { poolId: v.id("pools") },
  handler: async (ctx, args) => {
    const pool = await ctx.db.get("pools", args.poolId);
    if (!pool) return null;
    return { ...pool, numbers: await membersOf(ctx, args.poolId) };
  },
});

/** The memberships of one pool, in order. */
export const listPoolNumbers = query({
  args: { poolId: v.id("pools") },
  handler: async (ctx, args) => membersOf(ctx, args.poolId),
});

/**
 * The next number that may send, read without consuming budget.
 *
 * The runner calls this before claiming a step to decide whether to send or to
 * defer. The budget is spent by `consumeSender` at send time, not here.
 */
export const availableSender = internalQuery({
  args: { poolId: v.id("pools"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    return readAvailableSender(ctx, args.poolId, now);
  },
});
