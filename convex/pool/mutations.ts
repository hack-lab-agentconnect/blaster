import { internalMutation, mutation } from "../_generated/server.js";
import {
  assignNumber as assignNumberModel,
  consume,
  removeNumber as removeNumberModel,
  reorderNumbers as reorderNumbersModel,
} from "./model.js";
import {
  assignNumberArgsValidator,
  consumeSenderArgsValidator,
  createPoolArgsValidator,
  removeNumberArgsValidator,
  reorderNumbersArgsValidator,
  setPoolStatusArgsValidator,
} from "./types.js";
import {
  DEFAULT_DAILY_CAP_PER_NUMBER,
  DEFAULT_MIN_SPACING_MS,
  nonNegative,
} from "./utils.js";

/**
 * Pool writes.
 *
 * Thin wrappers over model.ts, plus the one internal mutation the runner uses to
 * reserve a sender. See docs/convex-naming-conventions.md (rule R5).
 */

export const createPool = mutation({
  args: createPoolArgsValidator,
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("a pool needs a name");
    return ctx.db.insert("pools", {
      name,
      status: "active",
      strategy: "sequential",
      cursor: -1,
      minSpacingMs: nonNegative(args.minSpacingMs, DEFAULT_MIN_SPACING_MS),
      dailyCapPerNumber: nonNegative(args.dailyCapPerNumber, DEFAULT_DAILY_CAP_PER_NUMBER),
      activeNumberCount: 0,
      nextAvailableAt: 0,
      createdAt: Date.now(),
    });
  },
});

export const setPoolStatus = mutation({
  args: setPoolStatusArgsValidator,
  handler: async (ctx, args) => {
    const pool = await ctx.db.get("pools", args.poolId);
    if (!pool) throw new Error(`unknown pool ${args.poolId}`);
    await ctx.db.patch("pools", args.poolId, { status: args.status });
    return args.poolId;
  },
});

/**
 * Add a number to a pool, or move an existing membership.
 *
 * The number is addressed in E.164 because that is the key the phone ledger and
 * Twenty share; the membership stores the resolved `phoneNumberId` as well, so
 * a pool never depends on the E.164 string continuing to resolve.
 */
export const assignNumber = mutation({
  args: assignNumberArgsValidator,
  handler: async (ctx, args) => {
    const number = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
    if (!number) throw new Error(`unknown phone number ${args.phoneNumber}`);
    return assignNumberModel(ctx, args.poolId, number._id, number.phoneNumber, args.order, Date.now());
  },
});

export const removeNumber = mutation({
  args: removeNumberArgsValidator,
  handler: async (ctx, args) => {
    const number = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
    if (!number) throw new Error(`unknown phone number ${args.phoneNumber}`);
    return removeNumberModel(ctx, args.poolId, number._id, Date.now());
  },
});

export const reorderNumbers = mutation({
  args: reorderNumbersArgsValidator,
  handler: async (ctx, args) => {
    await reorderNumbersModel(ctx, args.poolId, args.order, Date.now());
    return args.poolId;
  },
});

/**
 * Reserve the next sender for a send, spending its budget.
 *
 * Internal: only the runner may advance a pool. The caller must not fall back to
 * an unpooled number when this returns none — the answer is to defer, which is
 * what keeps work out of the carrier's limit queue.
 */
export const consumeSender = internalMutation({
  args: consumeSenderArgsValidator,
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    return consume(ctx, args.poolId, now);
  },
});
