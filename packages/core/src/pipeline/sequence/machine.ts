/**
 * The enrollment state machine: one actor per enrolled prospect.
 *
 * The lifecycle is a statechart because the dangerous part of a sequencer is not
 * sending, it is the set of ways a send can go wrong and which of them may be
 * retried. Written as a function that sends, that distinction is a comment. As
 * states it cannot be got wrong:
 *
 *   scheduled  -> evaluating -> claiming -> sending -> sent -> scheduled
 *                    |            |          |
 *                    |            |          +--> ambiguous  (outcome unknown)
 *                    |            +--> ambiguous  (claim held elsewhere)
 *                    +--> scheduled                  (ineligible, or deferred)
 *
 * `ambiguous` is the state that earns the machine. A read timeout after the
 * request was sent leaves you not knowing whether it was accepted, and billing
 * fires at submission, so an ambiguous send must never retry itself. It has no
 * TICK handler at all: the only way out is a RECONCILE, which is a decision
 * about a fact the machine cannot observe.
 *
 * The claim-before-send ordering is structural for the same reason. `claiming`
 * exists as a state so the runner cannot reach `sending` without having
 * presented the deterministic key to a store with a uniqueness constraint, and
 * so a second worker that loses that race is diverted to `ambiguous` rather
 * than sending a duplicate.
 *
 * No I/O happens here. `pendingEffect` in context is the machine's request to
 * the runner, mirroring how the conversation machine hands work to an injected
 * actor. The runner performs the effect and sends the outcome back as an event,
 * which is what lets this whole lifecycle be tested with no provider.
 */

import { assign, setup } from "xstate";
import { advance } from "./helpers/builder.ts";
import { quietHoursWindow } from "./helpers/quiet-hours.ts";
import {
  MAX_STEP_ATTEMPTS,
  RETRY_BACKOFF_MS,
  SKIP_RETRY_MS,
  claimKeyFor,
  type EnrollmentEvent,
  type EnrollmentMachineInput,
  type EnrollmentStatus,
  type SequenceEffect,
} from "./types.ts";

/** The verdict for the tick that is being decided, kept out of guards' return values. */
interface Verdict {
  eligible: boolean;
  reason: string | null;
  detail: string | null;
  quiet: boolean;
  /** When to reconsider, when the step is deferred. Null when computable now. */
  nextAllowedAt: number | null;
  /** True when the recipient's zone could not be read at all. */
  unplaceable: boolean;
}

interface EnrollmentContext {
  enrollmentId: string;
  sequenceId: string;
  cursor: number;
  steps: { text: string; delayHours: number; isStop: boolean }[];
  fromNumber: string;
  to: string | null;
  country: string | null;
  timeZone: string | null;
  approximateZone: boolean;
  nextDueAt: number | null;
  lastSentAt: number | null;
  status: EnrollmentStatus;
  attempts: number;
  lastSkipReason: string | null;
  /** The instant of the tick being decided. */
  now: number;
  sentInLastDay: number;
  doNotContact: boolean;
  hasReplied: boolean;
  /** The profile bound to the sending number, forwarded to eligibility. */
  numberProfileId?: string | null;
  evaluate: EnrollmentMachineInput["evaluate"];
  nextAllowedSendAt: EnrollmentMachineInput["nextAllowedSendAt"];
  verdict: Verdict | null;
  claimKey: string;
  pendingEffect: SequenceEffect;
  /** Why the last send's outcome is unknown. */
  ambiguousReason: string | null;
  /** The provider's id for the step that sent, kept for reconciliation. */
  lastMessageId: string | null;
}

const backoffFor = (attempts: number): number =>
  RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)] as number;

/**
 * Build the machine. Configuration arrives as XState `input` at
 * `createActor(machine, { input })`, not baked in here, so one machine definition
 * serves every enrollment and a test can drive a whole lifecycle by constructing
 * an actor with a different input.
 */
export function createEnrollmentMachine() {
  return setup({
    types: {
      context: {} as EnrollmentContext,
      events: {} as EnrollmentEvent,
      input: {} as EnrollmentMachineInput,
    },
    actions: {
      /** No effect. An event we deliberately ignore still has to be assignable. */
      ignore: assign(() => ({})),

      stampNow: assign(({ event }) => (event.type === "TICK" || event.type === "RESUME" ? { now: event.at } : {})),

      /**
       * Decide this tick, once, into context.
       *
       * Eligibility and the quiet-hours check are both injected and both pure,
       * so the machine can be driven with a stub in a test and with the real
       * rules in production without either knowing about the other.
       */
      evaluateTick: assign(({ context }) => {
        const verdict = context.evaluate({
          to: context.to,
          country: context.country,
          doNotContact: context.doNotContact,
          hasReplied: context.hasReplied,
          sentInLastDay: context.sentInLastDay,
          numberProfileId: context.numberProfileId ?? null,
        });
        const window = quietHoursWindow(context.timeZone, context.now, context.approximateZone);
        return {
          verdict: {
            eligible: verdict.eligible,
            reason: verdict.reason,
            detail: verdict.detail,
            quiet: window.quiet,
            nextAllowedAt: context.nextAllowedSendAt(context.now),
            unplaceable: window.localHour === null,
          },
        };
      }),

      /** The step is still owed, so reschedule rather than advancing. */
      rescheduleSkip: assign(({ context }) => ({
        nextDueAt: context.now + SKIP_RETRY_MS,
        lastSkipReason: context.verdict?.reason ?? "unspecified",
        status: "active" as const,
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /**
       * Quiet hours: push the step to the first allowed instant rather than
       * dropping it, so a sequence enrolled at 11pm still completes.
       */
      deferToWindow: assign(({ context }) => ({
        nextDueAt: context.verdict?.nextAllowedAt ?? context.now + SKIP_RETRY_MS,
        lastSkipReason: "quiet-hours",
        status: "active" as const,
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /**
       * The recipient could not be placed in a time zone, so no legal send time
       * can be computed. Parked for a human rather than guessed at.
       */
      parkUnplaceable: assign(() => ({
        nextDueAt: null,
        lastSkipReason: "unplaceable-recipient",
        status: "awaiting-human" as const,
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /**
       * Ask the runner to claim this step before anything is sent.
       *
       * The key is derived, not generated, so a retry of the same step presents
       * the same key and loses the uniqueness constraint rather than sending.
       */
      requestClaim: assign(({ context }) => ({
        claimKey: claimKeyFor(context.enrollmentId, context.cursor),
        pendingEffect: {
          type: "claim",
          key: claimKeyFor(context.enrollmentId, context.cursor),
        } as const,
      })),

      /** Ask the runner to send, carrying the key the claim was taken under. */
      requestSend: assign(({ context }) => ({
        pendingEffect: {
          type: "send",
          key: context.claimKey,
          to: context.to,
          fromNumber: context.fromNumber,
          text: context.steps[context.cursor]?.text ?? "",
        } as const,
      })),

      /**
       * The step went out: advance with the same `advance()` the rest of the
       * system already uses, so cursor arithmetic has one implementation and a
       * change to the rule cannot diverge between the batch path and the runner.
       */
      recordSuccess: assign(({ context, event }) => {
        const at = event.type === "SEND_SUCCEEDED" || event.type === "RECONCILE" ? event.at : context.now;
        const next = advance(
          context.steps,
          {
            id: context.enrollmentId,
            sequenceId: context.sequenceId,
            recipientId: context.enrollmentId,
            cursor: context.cursor,
            status: context.status === "active" ? "active" : "paused",
            enrolledAt: context.now,
            nextDueAt: context.nextDueAt,
            lastSentAt: context.lastSentAt,
          },
          at,
        );
        return {
          cursor: next.cursor,
          status: next.status === "active" ? ("active" as const) : ("completed" as const),
          nextDueAt: next.nextDueAt,
          lastSentAt: next.lastSentAt,
          attempts: 0,
          lastSkipReason: null,
          pendingEffect: { type: "none" } as const,
          verdict: null,
          lastMessageId: event.type === "SEND_SUCCEEDED" ? event.messageId : context.lastMessageId,
        };
      }),

      /** Retryable failure: back off, keep the cursor, and try again later. */
      scheduleRetry: assign(({ context }) => ({
        attempts: context.attempts + 1,
        nextDueAt: context.now + backoffFor(context.attempts),
        lastSkipReason: "send-failed",
        status: "active" as const,
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /** Out of attempts, or an error that will not fix itself. */
      recordFailure: assign(({ event }) => ({
        status: "failed" as const,
        nextDueAt: null,
        lastSkipReason: event.type === "SEND_FAILED" ? event.reason : "send-failed",
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /**
       * The outcome is unknown. The only things that change this are a
       * reconciliation decision or a pause; there is no path from here back to
       * `sending` on a timer.
       */
      recordAmbiguous: assign(({ event }) => ({
        status: "ambiguous" as const,
        nextDueAt: null,
        ambiguousReason: event.type === "SEND_AMBIGUOUS" ? event.reason : "claim-held-elsewhere",
        lastSkipReason: "ambiguous",
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      /** Reconciliation decided the send never happened: it is owed again. */
      releaseAmbiguous: assign(({ context, event }) => ({
        status: "active" as const,
        nextDueAt: event.type === "RECONCILE" ? event.at : context.now,
        ambiguousReason: null,
        lastSkipReason: "reconciled-not-sent",
        pendingEffect: { type: "none" } as const,
        verdict: null,
      })),

      stopOnReply: assign({ status: "replied", nextDueAt: null, pendingEffect: { type: "none" } } as Partial<EnrollmentContext>),
      stopOnOptOut: assign({ status: "opted-out", nextDueAt: null, pendingEffect: { type: "none" } } as Partial<EnrollmentContext>),
      pause: assign({ nextDueAt: null, status: "paused", pendingEffect: { type: "none" } } as Partial<EnrollmentContext>),
      finish: assign({ status: "completed", nextDueAt: null, pendingEffect: { type: "none" } } as Partial<EnrollmentContext>),
    },
    guards: {
      isDue: ({ context }) => context.nextDueAt === null || context.nextDueAt <= context.now,
      pastLastStep: ({ context }) => context.cursor >= context.steps.length,
      reachedStopStep: ({ context }) => context.steps[context.cursor]?.isStop === true,
      notEligible: ({ context }) => context.verdict?.eligible === false,
      recipientUnplaceable: ({ context }) => context.verdict?.unplaceable === true,
      withinQuietHours: ({ context }) => context.verdict?.quiet === true,
      /**
       * Retry only a failure that is both worth retrying and still has attempts
       * left. Both conditions, never either: checking only "retryable" would
       * retry a bad phone number until the ceiling, and checking only "attempts
       * left" would retry an error that will never succeed.
       */
      canRetrySend: ({ context, event }) =>
        event.type === "SEND_FAILED" && event.retryable && context.attempts < MAX_STEP_ATTEMPTS,
      /** Sticky suppression, so a reply after an opt-out cannot reopen it. */
      isOptedOut: ({ context }) => context.status === "opted-out",
      /** The reconciliation decision about the one fact the machine cannot see. */
      wentOut: ({ event }) => event.type === "RECONCILE" && event.wentOut,
    },
  }).createMachine({
    id: "enrollment",
    version: "1",
    // A restored enrollment is either waiting for its step or already parked.
    // Which one is decided by the runner, which sends RESUME for the parked
    // states rather than the machine guessing from context it cannot trust.
    initial: "scheduled",
    context: ({ input }) => ({
      enrollmentId: input.enrollmentId,
      sequenceId: input.sequenceId,
      cursor: input.cursor,
      steps: input.steps,
      fromNumber: input.fromNumber,
      to: input.to,
      country: input.country,
      timeZone: input.timeZone,
      approximateZone: input.approximateZone,
      nextDueAt: input.nextDueAt,
      lastSentAt: input.lastSentAt,
      status: input.status,
      attempts: input.attempts,
      lastSkipReason: input.lastSkipReason,
      now: input.now,
      sentInLastDay: input.sentInLastDay,
      doNotContact: input.doNotContact,
      hasReplied: input.hasReplied,
      numberProfileId: input.numberProfileId ?? null,
      evaluate: input.evaluate,
      nextAllowedSendAt: input.nextAllowedSendAt,
      verdict: null,
      claimKey: claimKeyFor(input.enrollmentId, input.cursor),
      pendingEffect: { type: "none" },
      ambiguousReason: input.status === "ambiguous" ? "restored" : null,
      lastMessageId: null,
    }),
    /**
     * Stop conditions, at the top level so they hold from every state.
     *
     * A reply or an opt-out is a fact about the person, not about the step, so
     * it has to win from wherever the machine happens to be. `opted_out` is
     * sticky: it records the message and never leaves through this machine, which
     * is the same rule the conversation machine follows.
     */
    on: {
      INBOUND_REPLY: [
        { guard: "isOptedOut", actions: "ignore" },
        { target: ".replied", actions: "stopOnReply" },
      ],
      OPT_OUT: { target: ".opted_out", actions: "stopOnOptOut" },
      PAUSE: { target: ".paused", actions: "pause" },
    },
    states: {
      scheduled: {
        on: {
          TICK: { target: "evaluating", actions: "stampNow" },
        },
      },

      evaluating: {
        entry: "evaluateTick",
        always: [
          { guard: "recipientUnplaceable", target: "awaiting_human", actions: "parkUnplaceable" },
          { guard: "pastLastStep", target: "completed", actions: "finish" },
          { guard: "reachedStopStep", target: "completed", actions: "finish" },
          { guard: "notEligible", target: "scheduled", actions: "rescheduleSkip" },
          { guard: "withinQuietHours", target: "scheduled", actions: "deferToWindow" },
          { target: "claiming" },
        ],
      },

      /**
       * The claim is taken before the send is attempted. Losing this race is not
       * a failure: it means another run already owns this exact step, and the
       * only safe thing to do is nothing.
       */
      claiming: {
        entry: "requestClaim",
        on: {
          CLAIM_TAKEN: { target: "sending" },
          CLAIM_HELD_BY_OTHER: { target: "ambiguous", actions: "recordAmbiguous" },
        },
      },

      sending: {
        entry: "requestSend",
        on: {
          SEND_SUCCEEDED: { target: "sent", actions: "recordSuccess" },
          SEND_AMBIGUOUS: { target: "ambiguous", actions: "recordAmbiguous" },
          SEND_FAILED: [
            { guard: "canRetrySend", target: "scheduled", actions: "scheduleRetry" },
            { target: "failed", actions: "recordFailure" },
          ],
        },
      },

      sent: {
        always: [
          { guard: "pastLastStep", target: "completed", actions: "finish" },
          { target: "scheduled" },
        ],
      },

      /**
       * The last send may or may not have reached the carrier. There is no TICK
       * handler, and that omission is the feature: nothing in this machine will
       * ever retry it on a timer.
       */
      ambiguous: {
        on: {
          RECONCILE: [
            { guard: "wentOut", target: "sent", actions: "recordSuccess" },
            { target: "scheduled", actions: "releaseAmbiguous" },
          ],
        },
      },

      /**
       * The recipient could not be placed in a time zone, so no send time can be
       * shown to be legal. Parked rather than guessed at.
       */
      awaiting_human: {
        on: {
          RESUME: { target: "scheduled", actions: "stampNow" },
        },
      },

      replied: {
        on: {
          // Terminal. A reply ends the sequence; the conversation machine takes
          // over from here.
          INBOUND_REPLY: { actions: "ignore" },
        },
      },

      opted_out: {
        on: {
          INBOUND_REPLY: { actions: "ignore" },
          RESUME: { target: "scheduled", actions: "stampNow" },
        },
      },

      paused: {
        on: {
          RESUME: { target: "scheduled", actions: "stampNow" },
        },
      },

      failed: {
        on: {
          RESUME: { target: "scheduled", actions: "stampNow" },
        },
      },

      completed: {
        type: "final",
      },
    },
  });
}

export type EnrollmentMachine = ReturnType<typeof createEnrollmentMachine>;
