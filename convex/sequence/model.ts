import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import {
  DEFAULT_OPTIONS,
  advance,
  type SequenceDraft,
  type SequenceStepDraft,
} from "../../packages/core/src/pipeline/sequence/index";
import { recordOutboundRow } from "../conversations/model.js";
import type { RecordedStepResult } from "./types.js";

/**
 * Sequence storage helpers.
 *
 * Context-bound logic shared by this domain's functions: draft shaping and the
 * enrollment stop that `recordInboundMessage` calls inside its own transaction.
 * The send-or-skip decisions stay in packages/core; this file only reads, writes,
 * and shapes.
 */

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
  ctx: MutationCtx,
  peerNumber: string,
  now = Date.now(),
  status: "replied" | "opted-out" = "replied",
): Promise<
  { enrollmentId: string; sequenceId: string; status: string; ownerMemberId: string | null }[]
> {
  if (!peerNumber) return [];
  // One contact's enrollments, matched on the E.164 `to` column. A contact is
  // enrolled per campaign, so this is a handful of rows, not a table scan.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const enrollments = await ctx.db
    .query("sequenceEnrollments")
    .withIndex("to", (q) => q.eq("to", peerNumber))
    .collect();

  const stopped: {
    enrollmentId: string;
    sequenceId: string;
    status: string;
    ownerMemberId: string | null;
  }[] = [];
  for (const enrollment of enrollments) {
    // Only an enrollment that owes another message has anything to stop. A
    // paused or completed one is already not sending, and rewriting it would
    // lose the reason it reached that state.
    if (enrollment.status !== "active") continue;
    // An opt-out is terminal and sticky where a reply is merely a stop: a
    // prospect who unsubscribed must never be re-enrolled by a later run, and
    // a manual send must still reach them only by explicit operator action.
    // The caller decides which one this is; this function never guesses from
    // message text.
    await ctx.db.patch("sequenceEnrollments", enrollment._id, {
      status,
      // Cleared rather than left in the past: a row with a due time in the past
      // is a row `dueEnrollments` would keep returning.
      nextDueAt: undefined,
      // `undefined`, not null. The field is v.optional(v.string()), so null
      // fails write validation and `stopEnrollmentsForPeer` throws on every
      // reply. Unsetting is what Convex means by "no reason".
      lastSkipReason: undefined,
    });
    stopped.push({
      enrollmentId: enrollment._id,
      sequenceId: enrollment.sequenceId,
      status,
      ownerMemberId:
        typeof enrollment.ownerMemberId === "string" ? enrollment.ownerMemberId : null,
    });
  }
  void now;
  return stopped;
}

export interface SentMessage {
  to: string;
  from: string;
  text: string;
  telnyxMessageId: string;
  sentAt: number;
}

/**
 * Apply a completed send: advance the cursor and record the message row.
 *
 * One transaction, both facts. The outbound row is what the daily cap counts
 * and what the thread displays; writing it anywhere else would let the cap
 * undercount and the thread go silent about sends the runner performed. When
 * no message is known — a reconciliation that concluded the send went out but
 * has no id for it — only the cursor moves.
 *
 * Shared by `recordStep` and reconcile paths so the two cannot disagree about
 * what "sent" means.
 */
export async function applySentOutcome(
  ctx: MutationCtx,
  enrollment: Doc<"sequenceEnrollments">,
  steps: SequenceStepDraft[],
  at: number,
  message?: SentMessage,
): Promise<RecordedStepResult> {
  const next = advance(
    steps,
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
    at,
  );
  await ctx.db.patch("sequenceEnrollments", enrollment._id, {
    cursor: next.cursor,
    status: next.status,
    nextDueAt: next.nextDueAt ?? undefined,
    lastSentAt: next.lastSentAt ?? undefined,
    lastSkipReason: undefined,
  });
  if (message) {
    await storeOutboundMessage(ctx, message);
  }
  // Core types the resulting status as the whole `EnrollmentStatus` union, but a
  // send that went out only ever leaves the enrollment active (steps still owed)
  // or completed. Narrowing to those two is what keeps `RecordedStepResult` a
  // statement about reality rather than a cast that happens to compile.
  return next.status === "completed"
    ? {
        status: "completed",
        cursor: next.cursor,
        nextDueAt: next.nextDueAt ?? null,
        lastSentAt: next.lastSentAt ?? null,
      }
    : { status: "active", attempts: enrollment.attempts ?? 0 };
}

/**
 * Resolve the peer's conversation and append the outbound row. The write
 * itself lives in conversations/model.ts — this domain asks for it rather
 * than reaching into another domain's tables, the same way the inbound path
 * calls into sequence/model.ts from the other direction. Static import is
 * safe: neither model file imports the other at module scope in a cycle.
 */
async function storeOutboundMessage(ctx: MutationCtx, message: SentMessage): Promise<void> {
  await recordOutboundRow(ctx, message);
}
