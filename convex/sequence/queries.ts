import { query } from "../_generated/server.js";
import { v } from "convex/values";
import {
  summarise,
  validateDraft,
} from "../../packages/core/src/pipeline/sequence/index";
import { STEP_FIELDS, draftFromArgs } from "./model.js";

/**
 * Sequence reads.
 *
 * Thin wrappers over model.ts: validate args, call one model function, return.
 * See docs/convex-naming-conventions.md (rule R5).
 */

/** Check a draft without persisting it, so a builder can show every problem. */
export const validateSequence = query({
  args: {
    name: v.string(),
    fromNumber: v.string(),
    steps: v.array(v.object(STEP_FIELDS)),
    dailyCapPerRecipient: v.optional(v.number()),
  },
  handler: async (_ctx, args) => {
    const draft = draftFromArgs({
      name: args.name,
      fromNumber: args.fromNumber,
      options: { dailyCapPerRecipient: args.dailyCapPerRecipient ?? 0 },
      steps: args.steps,
    });
    return { problems: validateDraft(draft), summary: summarise(draft) };
  },
});

export const listSequences = query({
  args: {},
  handler: async (ctx) => {
    const sequences = await ctx.db.query("sequences").collect();
    return sequences
      .map((sequence) => ({
        ...sequence,
        summary: summarise({
          name: sequence.name,
          fromNumber: sequence.fromNumber,
          options: sequence.options,
          steps: Array.from({ length: sequence.stepCount }, () => ({ text: "", delayHours: 0, isStop: false })),
        }),
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** A sequence with its steps in order, which is what a preview needs. */
export const getSequence = query({
  args: { sequenceId: v.id("sequences") },
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get(args.sequenceId);
    if (!sequence) return null;
    const steps = await ctx.db
      .query("sequenceSteps")
      .withIndex("sequenceId", (q) => q.eq("sequenceId", args.sequenceId))
      .collect();
    steps.sort((a, b) => a.order - b.order);
    return { ...sequence, steps };
  },
});

export const listEnrollments = query({
  args: { sequenceId: v.id("sequences"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("sequenceEnrollments")
      .withIndex("sequenceId", (q) => q.eq("sequenceId", args.sequenceId))
      .take(args.limit ?? 100);
    return rows;
  },
});

/** Enrollments whose next step is due.
 *
 * The runner reads this and nothing else decides what is due, so a cron and a
 * manual run cannot disagree about the queue.
 */
export const dueEnrollments = query({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    return ctx.db
      .query("sequenceEnrollments")
      .withIndex("nextDueAt")
      .collect()
      .then((rows) =>
        rows
          .filter((row) => row.status === "active" && (row.nextDueAt ?? Infinity) <= now)
          .slice(0, args.limit ?? 50),
      );
  },
});
