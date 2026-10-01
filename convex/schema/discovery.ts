import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for cost-bounded discovery runs. */
export const discoveryTables = {
  /** Cost ceiling and outcome for one discovery run. */
  discoveryRuns: defineTable({
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    maxCostUsd: v.number(),
    spentUsd: v.optional(v.number()),
    prospectsFound: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("startedAt", ["startedAt"]),
};
