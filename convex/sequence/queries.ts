import { internalQuery, query } from "../_generated/server.js";
import { v } from "convex/values";
import {
  summarise,
  validateDraft,
} from "../../packages/core/src/pipeline/sequence/index";
import { draftFromArgs } from "./model.js";
import { stepFieldsValidator } from "./types.js";
// Aliased: the query below is addressed as `loadRunContext`, so importing the
// helper under the same name would shadow it and recurse into itself.
import { dueEnrollmentIds, loadRunContext as readRunContext } from "./helpers.js";
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, clamp } from "./utils.js";

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
    steps: v.array(stepFieldsValidator),
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

/**
 * Sequences, newest first.
 *
 * `limit` is optional and defaulted rather than required so every existing
 * caller keeps working and still gets a bounded read; the alternative was a
 * whole-table read whose cost grew with every sequence ever created instead of
 * with the page returned.
 */
export const listSequences = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const sequences = await ctx.db
      .query("sequences")
      .withIndex("createdAt", (q) => q)
      .order("desc")
      .take(clamp(args.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
    return sequences.map((sequence) => ({
      ...sequence,
      summary: summarise({
        name: sequence.name,
        fromNumber: sequence.fromNumber,
        options: sequence.options,
        steps: Array.from({ length: sequence.stepCount }, () => ({ text: "", delayHours: 0, isStop: false })),
      }),
    }));
  },
});

/** A sequence with its steps in order, which is what a preview needs. */
export const getSequence = query({
  args: { sequenceId: v.id("sequences") },
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get("sequences", args.sequenceId);
    if (!sequence) return null;
    // The steps of one sequence, a count the caller itself wrote and a preview
    // needs in full. The set is bounded by that count rather than by the table.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
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
    // A compound range, not a scan: `status` is the equality prefix and
    // `nextDueAt` the range. Enrollments with no due time are absent from the
    // index and therefore absent from the queue, which is the intent — a row
    // that owes nothing is not work.
    return ctx.db
      .query("sequenceEnrollments")
      .withIndex("statusNextDueAt", (q) =>
        q.eq("status", "active").lte("nextDueAt", now),
      )
      .take(args.limit ?? 50);
  },
});

/**
 * The ids the runner should consider this tick.
 *
 * A thin boundary over `helpers.ts`: the read logic has one implementation, and
 * the action cannot reach the database itself (Convex actions have no `db`), so
 * this query is how it asks.
 */
export const runDueEnrollmentIds = internalQuery({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    return dueEnrollmentIds(ctx, now, args.limit ?? 25);
  },
});

/**
 * Everything one step's decision rests on, read in one consistent snapshot.
 *
 * `null` means the enrollment or its sequence is gone. A wrong status is
 * returned rather than hidden: the runner re-reads after claiming, because a
 * reply can stop an enrollment between the first read and the send.
 */
export const loadRunContext = internalQuery({
  args: { enrollmentId: v.id("sequenceEnrollments"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    return readRunContext(ctx, args.enrollmentId, now);
  },
});

/**
 * One sequence's scheduling identity, for a caller that has only its id.
 *
 * The enroll seam reads this to confirm the sequence exists before it walks
 * Twenty; the full row with steps is `getSequence`, which the seam does not need.
 */
export const sequenceById = internalQuery({
  args: { sequenceId: v.id("sequences") },
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get("sequences", args.sequenceId);
    if (!sequence) return null;
    return {
      _id: sequence._id,
      name: sequence.name,
      status: sequence.status,
      fromNumber: sequence.fromNumber,
      poolId: sequence.poolId,
    };
  },
});
