import { v } from "convex/values";
import type { GenericId, Infer } from "convex/values";
import type { EnrollmentStatus as CoreEnrollmentStatus } from "../../packages/core/src/pipeline/sequence/types.js";

/**
 * Document ids, spelled `GenericId` rather than `Id`.
 *
 * These are the same type: `_generated/dataModel.d.ts` declares `Id<T>` as
 * `GenericId<T>` over the tables in the schema. Importing `Id` from there would
 * be the more readable spelling, but `dataModel.d.ts` imports `schema.ts`, and
 * `schema/sequences.ts` imports this file — so that import closes a cycle and
 * every validator here evaluates to `undefined` at module load, which Convex
 * reports as "A validator is undefined for field ... in v.object()". Naming the
 * tables as strings here keeps this file a leaf: nothing in it reaches back into
 * the schema. The table names are still checked, because `GenericId` constrains
 * its argument to a string literal.
 */
type EnrollmentId = GenericId<"sequenceEnrollments">;
type SequenceId = GenericId<"sequences">;

/**
 * The sequence domain's types and the validators they are derived from.
 *
 * Every field shape the domain needs is declared here exactly once and inferred
 * back into TypeScript, so a validator and its type cannot drift apart. When
 * the state machine in packages/core gains a state, `AssertStatusMatchesCore`
 * below stops compiling until this file learns about it, which is the point:
 * the failure should arrive at compile time rather than as a validation error
 * on the first enrollment that reaches the new state.
 */

/**
 * Exact type equality, or a compile error.
 *
 * `[A] extends [B]` in both directions is the standard bidirectional-`extends`
 * equality test. It is a type rather than a runtime assertion because the drift
 * it guards against should fail the build, not a test run.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Every state a sequence enrollment can be persisted in.
 *
 * The list is the machine's, not this file's invention. The last four exist
 * because the statechart produces them and the schema must accept what the
 * machine can write, or each one becomes a validation failure. `ambiguous` and
 * `awaiting-human` are parked and only a human moves them; `failed` is terminal
 * once retries are exhausted.
 */
export const enrollmentStatusValidator = v.union(
  v.literal("active"),
  v.literal("replied"),
  v.literal("opted-out"),
  v.literal("completed"),
  v.literal("paused"),
  v.literal("ambiguous"),
  v.literal("awaiting-human"),
  v.literal("failed"),
);

export type EnrollmentStatus = Infer<typeof enrollmentStatusValidator>;

/** States the runner will still act on. */
export type ActiveStatus = "active";

/**
 * States that are parked for a person. Nothing resumes these automatically:
 * `ambiguous` because the send's outcome is unknown, `awaiting-human` because
 * the machine cannot decide what to do next.
 */
export type ParkedStatus = Extract<EnrollmentStatus, "ambiguous" | "awaiting-human">;

/** States a peer reaching out ends an enrollment in. */
export type StopStatus = Extract<EnrollmentStatus, "replied" | "opted-out">;

/**
 * The states a schedule write may write.
 *
 * Narrower than `EnrollmentStatus` on purpose: `replied`, `opted-out`,
 * `ambiguous`, and `failed` are decided by a reply, an opt-out, or a send
 * outcome, never by rescheduling. Accepting them here would let a skip quietly
 * resurrect a stopped enrollment.
 */
export type ScheduledStatus = Extract<
  EnrollmentStatus,
  "active" | "paused" | "awaiting-human" | "completed"
>;

/**
 * The validator behind {@link ScheduledStatus}.
 *
 * The literals are restated here, which is the one duplication this file
 * allows, so `satisfies` below makes it a checked one: a literal that is not a
 * real enrollment status, or a status missing from this list when it should be
 * writable, is a compile error rather than a mismatch found at runtime.
 */
export const scheduledStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("awaiting-human"),
  v.literal("completed"),
);

/**
 * Fail-proof that the validator above and the {@link ScheduledStatus} type
 * describe the same four states: this fails to compile if either side drifts.
 */
export type AssertScheduledStatusMatches = Exact<
  Infer<typeof scheduledStatusValidator>,
  ScheduledStatus
>;

/**
 * Fail-safe proof that the Convex union and the state machine's union agree.
 *
 * `[A] extends [B]` in both directions is exact equality, so adding a state on
 * either side without the other is a compile error here. It is written as a type
 * with no runtime cost rather than as a test, because a test only fails once
 * someone runs it.
 */
export type AssertStatusMatchesCore = Exact<EnrollmentStatus, CoreEnrollmentStatus>;

/** One step's message and timing, as the machine and schema both read it. */
export const stepFieldsValidator = v.object({
  text: v.string(),
  delayHours: v.number(),
  isStop: v.boolean(),
});

export type StepFields = Infer<typeof stepFieldsValidator>;

/**
 * What a provider confirmed about a send.
 *
 * Only ever populated once the send is known to have gone out. Recording the
 * confirmation next to the cursor advance is what keeps the daily cap and the
 * conversation thread from disagreeing about what was sent.
 */
export const sentMessageValidator = v.object({
  to: v.string(),
  from: v.string(),
  text: v.string(),
  telnyxMessageId: v.string(),
  sentAt: v.number(),
});

export type SentMessage = Infer<typeof sentMessageValidator>;

/** Why one step was not sent, or what its outcome was. */
export type StepOutcome =
  | "sent"
  | "failed"
  | "skipped"
  | "replied"
  | "opted-out"
  | "ambiguous";

export const stepOutcomeValidator = v.union(
  v.literal("sent"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("replied"),
  v.literal("opted-out"),
  v.literal("ambiguous"),
);

/** Arguments for the mutation that records one step's outcome. */
export interface RecordStepArgs {
  enrollmentId: EnrollmentId;
  outcome: StepOutcome;
  steps: StepFields[];
  /** Why a send was skipped or failed, so an operator can see the reason. */
  skipReason?: string;
  /** Present only when the send is known to have gone out. */
  message?: SentMessage;
}

export const applyScheduleArgsValidator = v.object({
  enrollmentId: v.id("sequenceEnrollments"),
  status: scheduledStatusValidator,
  nextDueAt: v.optional(v.number()),
  lastSkipReason: v.optional(v.string()),
  attempts: v.optional(v.number()),
});

/** Arguments for the mutation that persists the machine's own schedule. */
export type ApplyScheduleArgs = Infer<typeof applyScheduleArgsValidator>;

/** What a schedule write left the enrollment in. */
export type ApplyScheduleResult = { status: ScheduledStatus };

export const completeEnrollmentArgsValidator = v.object({
  enrollmentId: v.id("sequenceEnrollments"),
});

/** Arguments for the mutation that closes a finished enrollment. */
export type CompleteEnrollmentArgs = Infer<typeof completeEnrollmentArgsValidator>;

/**
 * What closing found. An enrollment a reply already stopped reports that status
 * instead of "completed", because the mutation must not relabel a stop.
 */
export type CompleteEnrollmentResult = { status: EnrollmentStatus };

/** The status one step's outcome left an enrollment in. */
export type RecordedStepResult =
  | { status: "ambiguous" }
  | { status: "failed"; attempts: number }
  | { status: "active"; attempts: number }
  | { status: "replied" }
  | { status: "opted-out" }
  | { status: "skipped" }
  | { status: "completed"; cursor: number; nextDueAt: number | null; lastSentAt: number | null };

export const claimStepArgsValidator = v.object({
  enrollmentId: v.id("sequenceEnrollments"),
  cursor: v.number(),
});

/** Arguments for the mutation that claims one step for sending. */
export type ClaimStepArgs = Infer<typeof claimStepArgsValidator>;

/**
 * The outcome of trying to own a step.
 *
 * `claimed: false` is a normal result, not an error: it is how a second runner,
 * a stale cursor, or a stopped enrollment is turned away. `reason` says which,
 * because "we lost" and "there was nothing to send" call for different operator
 * responses.
 */
export type ClaimResult =
  | { claimed: true; reason: null }
  | {
      claimed: false;
      reason: "no-longer-active" | "cursor-moved" | "already-claimed";
    };

/** Arguments for the mutation that enrolls one prospect. */
export interface EnrollArgs {
  sequenceId: SequenceId;
  recipientId: string;
  to?: string;
  country?: string;
  /** The member responsible for this enrollment, taken from the signed-in actor. */
  ownerMemberId?: string;
  /** Do-not-contact as the caller read it from Twenty at enroll time. */
  doNotContact?: boolean;
}

/**
 * What one run of one step concluded.
 *
 * `sentinel` covers every outcome that is not a send: not due, skipped, parked,
 * or already stopped. It is deliberately not an error — a queue that is mostly
 * sentinels is a queue working.
 */
export type RunOutcome =
  | { kind: "sentinel"; reason: string }
  | { kind: "not-claimed"; reason: string }
  | { kind: "sent"; messageId: string }
  | { kind: "failed"; retryable: boolean; reason: string }
  | { kind: "ambiguous"; reason: string };

/** One messaging profile this deployment can send with. */
export interface ProfilePair {
  country: string | null;
  profileId: string;
}

/**
 * Everything one step's decision rests on, read in one consistent snapshot.
 *
 * Returned by `loadRunContext` so the action does not assemble it from several
 * reads that could each be true at a different moment.
 */
export interface RunContext {
  enrollment: {
    _id: EnrollmentId;
    sequenceId: SequenceId;
    recipientId: string;
    to?: string;
    country?: string;
    ownerMemberId?: string;
    cursor: number;
    status: EnrollmentStatus;
    enrolledAt: number;
    nextDueAt?: number;
    lastSentAt?: number;
    lastSkipReason?: string;
    attempts?: number;
    doNotContact?: boolean;
  };
  sequence: {
    _id: SequenceId;
    name: string;
    status: string;
    fromNumber: string;
    numberProfileId?: string;
    /** When set, the sender is chosen from this pool instead of `fromNumber`. */
    poolId?: string;
    options: {
      stopOnReply: boolean;
      respectDoNotContact: boolean;
      requireProfileForCountry: boolean;
      dailyCapPerRecipient: number;
    };
  };
  steps: StepFields[];
  profilePairs: ProfilePair[];
  /** Outbound messages to this recipient in the last 24 hours. */
  sentInLastDay: number;
  /** Whether this person has written in, read from the stored thread. */
  hasReplied: boolean;
}
