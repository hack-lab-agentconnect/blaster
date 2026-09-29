import { internalMutation, mutation, query } from "./_generated/server.js";
import { v } from "convex/values";
import {
  DEFAULT_OPTIONS,
  advance,
  dueAtForStep,
  summarise,
  validateDraft,
  type SequenceDraft,
  type SequenceStepDraft,
} from "../packages/core/src/pipeline/sequence/index";

/**
 * Sequence building and enrollment.
 *
 * The rules about what may be sent live in packages/core as pure functions.
 * These functions are the storage and the transaction boundary around them, and
 * they hold no judgement of their own beyond what the domain already decided.
 */

const STEP_FIELDS = {
  text: v.string(),
  delayHours: v.number(),
  isStop: v.boolean(),
};

function draftFromArgs(args: {
  name: string;
  fromNumber: string;
  numberProfileId?: string;
  campaignId?: string;
  options?: Partial<typeof DEFAULT_OPTIONS>;
  steps: Array<{ text: string; delayHours: number; isStop?: boolean }>;
}): SequenceDraft {
  return {
    name: args.name,
    fromNumber: args.fromNumber,
    numberProfileId: args.numberProfileId,
    campaignId: args.campaignId,
    options: { ...DEFAULT_OPTIONS, ...args.options },
    steps: args.steps.map((step) => ({
      text: step.text,
      delayHours: step.delayHours,
      isStop: step.isStop ?? false,
    })),
  };
}

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

export const createSequence = mutation({
  args: {
    name: v.string(),
    fromNumber: v.string(),
    numberProfileId: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    options: v.optional(
      v.object({
        stopOnReply: v.boolean(),
        respectDoNotContact: v.boolean(),
        requireProfileForCountry: v.boolean(),
        dailyCapPerRecipient: v.number(),
      }),
    ),
    steps: v.array(v.object(STEP_FIELDS)),
  },
  handler: async (ctx, args) => {
    const draft = draftFromArgs(args);
    const problems = validateDraft(draft);
    if (problems.length > 0) {
      // Thrown rather than returned: a half-built sequence is never stored, and
      // a caller that ignored the validation would otherwise get one anyway.
      throw new Error(`invalid sequence: ${problems.map((p) => `${p.field} ${p.problem}`).join(" ")}`);
    }

    const sequenceId = await ctx.db.insert("sequences", {
      name: draft.name,
      status: "draft",
      fromNumber: draft.fromNumber,
      numberProfileId: draft.numberProfileId,
      campaignId: draft.campaignId,
      stepCount: draft.steps.length,
      options: draft.options,
      createdAt: Date.now(),
    });

    for (const [order, step] of draft.steps.entries()) {
      await ctx.db.insert("sequenceSteps", { sequenceId, order, ...step });
    }
    return sequenceId;
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

export const setSequenceStatus = mutation({
  args: {
    sequenceId: v.id("sequences"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("completed"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.sequenceId, { status: args.status });
    return args.sequenceId;
  },
});

/**
 * Enroll a prospect.
 *
 * The first step is due immediately, so enrolling does not itself schedule a
 * wait the operator did not ask for.
 */
export const enroll = mutation({
  args: {
    sequenceId: v.id("sequences"),
    recipientId: v.string(),
    to: v.optional(v.string()),
    country: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const sequence = await ctx.db.get(args.sequenceId);
    if (!sequence) throw new Error(`unknown sequence ${args.sequenceId}`);
    if (sequence.status !== "active") {
      throw new Error(`sequence ${args.sequenceId} is ${sequence.status}, so nothing can be enrolled`);
    }

    const steps = await ctx.db
      .query("sequenceSteps")
      .withIndex("sequenceId", (q) => q.eq("sequenceId", args.sequenceId))
      .collect();
    const ordered: SequenceStepDraft[] = steps
      .sort((a, b) => a.order - b.order)
      .map(({ text, delayHours, isStop }) => ({ text, delayHours, isStop }));

    const enrolledAt = Date.now();
    return ctx.db.insert("sequenceEnrollments", {
      sequenceId: args.sequenceId,
      recipientId: args.recipientId,
      to: args.to,
      country: args.country,
      cursor: 0,
      status: "active",
      enrolledAt,
      nextDueAt: dueAtForStep(ordered, 0, enrolledAt) ?? undefined,
    });
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

/**
 * Enrollments whose next step is due.
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

/**
 * Record the outcome of one step: sent, skipped, replied, or opted out.
 *
 * Keeping the transition in one place is what makes the sequence resumable
 * after a failure without double-sending.
 */
export const recordStep = internalMutation({
  args: {
    enrollmentId: v.id("sequenceEnrollments"),
    outcome: v.union(
      v.literal("sent"),
      v.literal("skipped"),
      v.literal("replied"),
      v.literal("opted-out"),
    ),
    /** Why a send was skipped, so an operator can see the reason. */
    skipReason: v.optional(v.string()),
    steps: v.array(v.object(STEP_FIELDS)),
  },
  handler: async (ctx, args) => {
    const enrollment = await ctx.db.get(args.enrollmentId);
    if (!enrollment) throw new Error(`unknown enrollment ${args.enrollmentId}`);

    if (args.outcome === "replied") {
      await ctx.db.patch(args.enrollmentId, { status: "replied", nextDueAt: undefined });
      return { status: "replied" as const };
    }
    if (args.outcome === "opted-out") {
      await ctx.db.patch(args.enrollmentId, { status: "opted-out", nextDueAt: undefined });
      return { status: "opted-out" as const };
    }
    if (args.outcome === "skipped") {
      // A skip does not advance the cursor: the step is still owed, and the
      // reason is recorded so a human can decide whether to fix or pause.
      await ctx.db.patch(args.enrollmentId, { lastSkipReason: args.skipReason ?? "unspecified" });
      return { status: "skipped" as const };
    }

    // The Convex doc carries `_id` where core's Enrollment expects `id`,
    // so map it explicitly rather than passing the doc straight through.
    const next = advance(
      args.steps,
      {
        id: enrollment._id,
        sequenceId: enrollment.sequenceId,
        recipientId: enrollment.recipientId,
        cursor: enrollment.cursor,
        status: enrollment.status,
        enrolledAt: enrollment.enrolledAt,
        nextDueAt: enrollment.nextDueAt ?? null,
        lastSentAt: enrollment.lastSentAt ?? null,
      },
      Date.now(),
    );
    await ctx.db.patch(args.enrollmentId, {
      cursor: next.cursor,
      status: next.status,
      nextDueAt: next.nextDueAt ?? undefined,
      lastSentAt: next.lastSentAt ?? undefined,
      lastSkipReason: undefined,
    });
    return next;
  },
});
