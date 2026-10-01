import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for number pools: ordered sender groups with per-number rate state. */
export const poolTables = {
  /**
   * A pool of sending numbers worked in order.
   *
   * The pool owns the dispatch pointer (`cursor`) and the rollup fields the
   * status surface reads (`activeNumberCount`, `nextAvailableAt`). The per-number
   * rate budget lives on `poolNumbers`, because a single value cannot describe
   * several numbers at different points in their windows.
   */
  pools: defineTable({
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("paused")),
    /** Only sequential dispatch is implemented; the field is the seam for more. */
    strategy: v.union(v.literal("sequential")),
    /** The `order` of the member most recently used, so the walk resumes there. */
    cursor: v.number(),
    /** Minimum gap between two sends from one number. */
    minSpacingMs: v.number(),
    /** Messages per number per rolling day. 0 disables the cap. */
    dailyCapPerNumber: v.number(),
    /** Rollup: how many members can currently send. */
    activeNumberCount: v.number(),
    /** Rollup: the earliest instant the pool could next send. */
    nextAvailableAt: v.number(),
    lastDispatchedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("name", ["name"]),

  /**
   * One number's membership in one pool, with the state that decides the send.
   *
   * This is the relation that groups numbers: `poolId` plus `phoneNumberId`,
   * with `order` giving the sequential position. `status`, `nextAvailableAt`,
   * `sentToday`, and `dayStartedAt` are the relational status a caller reads to
   * see exactly what the pool is doing — a number is not deleted when it leaves,
   * it is marked `removed`, so an in-flight send still resolves and the audit
   * survives.
   */
  poolNumbers: defineTable({
    poolId: v.id("pools"),
    phoneNumberId: v.id("phoneNumbers"),
    /** E.164, denormalised so a removal addresses the membership by number. */
    phoneNumber: v.string(),
    /** Sequential position. Gaps are tolerated; `reorderNumbers` compacts them. */
    order: v.number(),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("removed")),
    /** Start of the window `sentToday` counts over. */
    dayStartedAt: v.number(),
    sentToday: v.number(),
    /** Earliest this number may send again, from the spacing budget. */
    nextAvailableAt: v.number(),
    lastSentAt: v.optional(v.number()),
    assignedAt: v.number(),
    removedAt: v.optional(v.number()),
  })
    .index("poolPhoneNumber", ["poolId", "phoneNumberId"])
    .index("poolOrder", ["poolId", "order"])
    .index("poolStatusOrder", ["poolId", "status", "order"]),
};
