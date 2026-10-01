import { v } from "convex/values";
import {
  DEFAULT_OPTIONS,
  type SequenceDraft,
} from "../../packages/core/src/pipeline/sequence/index";

/**
 * Sequence storage helpers.
 *
 * Context-bound logic shared by this domain's functions: draft shaping and the
 * enrollment stop that `recordInboundMessage` calls inside its own transaction.
 * The send-or-skip decisions stay in packages/core; this file only reads, writes,
 * and shapes.
 */

export const STEP_FIELDS = {
  text: v.string(),
  delayHours: v.number(),
  isStop: v.boolean(),
};

export function draftFromArgs(args: {
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

/**
 * Stop every active enrollment belonging to a peer who just wrote in.
 *
 * A plain function rather than a mutation, so `recordInboundMessage` can call it
 * inside the same transaction that stores the message. That matters for two
 * reasons: a reply that is stored but does not stop the sequence keeps texting
 * someone who answered, and a stop that succeeds while the store fails reports a
 * false negative to the operator. One transaction, both facts.
 *
 * The peer is matched on the E.164 `to` column rather than the recipient id,
 * because the webhook knows the number and not the id. Enrollments whose
 * recipient was never recorded in E.164 are not matched here, and
 * `conversations.ts`'s own comment already notes that case.
 *
 * Returns the enrollments it stopped, so a caller can decide whether this reply
 * is newsworthy enough to tell a human about.
 */
export async function stopEnrollmentsForPeer(
  ctx: { db: { patch: Function; query: Function } },
  peerNumber: string,
  now = Date.now(),
): Promise<{ enrollmentId: string; sequenceId: string; status: string }[]> {
  if (!peerNumber) return [];
  const enrollments = await ctx.db
    .query("sequenceEnrollments")
    .withIndex("to", (q: { eq: (field: string, value: string) => unknown }) =>
      q.eq("to", peerNumber),
    )
    .collect();

  const stopped: { enrollmentId: string; sequenceId: string; status: string }[] = [];
  for (const enrollment of enrollments) {
    // Only an enrollment that owes another message has anything to stop. A
    // paused or completed one is already not sending, and rewriting it would
    // lose the reason it reached that state.
    if (enrollment.status !== "active") continue;
    await ctx.db.patch(enrollment._id, {
      status: "replied",
      // Cleared rather than left in the past: a row with a due time in the past
      // is a row `dueEnrollments` would keep returning.
      nextDueAt: undefined,
      lastSkipReason: null,
    });
    stopped.push({
      enrollmentId: enrollment._id,
      sequenceId: enrollment.sequenceId,
      status: "replied",
    });
  }
  void now;
  return stopped;
}
