import { v } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { dueAtForStep, type SequenceStepDraft } from "../../packages/core/src/pipeline/sequence/index";
import { isSuppressed } from "../suppressions/model.js";

/**
 * The enrollment write, shared by the public `enroll` mutation and the internal
 * `enrollInternal` the Twenty seam uses.
 *
 * Context-bound logic in `model.ts` rather than in the function file, so the two
 * boundaries (a client enrolling one prospect, and the seam enrolling a batch of
 * them) cannot disagree about what enrolling means. See
 * docs/convex-naming-conventions.md (rule R5/R11).
 */
export async function enrollRecipient(
  ctx: MutationCtx,
  args: {
    sequenceId: Id<"sequences">;
    recipientId: string;
    to?: string;
    country?: string;
    ownerMemberId?: string;
    doNotContact?: boolean;
  },
): Promise<Id<"sequenceEnrollments">> {
  const sequence = await ctx.db.get("sequences", args.sequenceId);
  if (!sequence) throw new Error(`unknown sequence ${args.sequenceId}`);
  if (sequence.status !== "active") {
    throw new Error(`sequence ${args.sequenceId} is ${sequence.status}, so nothing can be enrolled`);
  }

  // Refuse to enroll a suppressed peer. This is the durable check the
  // enrollment snapshot cannot make: a person who sent STOP in another
  // sequence, from another number, must not be enrolled here. The snapshot
  // below still covers the case Convex cannot ask Twenty about.
  if (args.to && (await isSuppressed(ctx, args.to))) {
    throw new Error(`${args.to} is suppressed, so nothing can be enrolled`);
  }

  // The steps of one sequence, which enrollment copies into the enrollment's
  // own snapshot. The set is bounded by that sequence's own step count.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
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
    ...(args.ownerMemberId ? { ownerMemberId: args.ownerMemberId } : {}),
    cursor: 0,
    status: "active",
    enrolledAt,
    doNotContact: args.doNotContact ?? false,
    nextDueAt: dueAtForStep(ordered, 0, enrolledAt) ?? undefined,
  });
}

export const enrollArgsValidator = v.object({
  sequenceId: v.id("sequences"),
  recipientId: v.string(),
  to: v.optional(v.string()),
  country: v.optional(v.string()),
  ownerMemberId: v.optional(v.string()),
  doNotContact: v.optional(v.boolean()),
});
