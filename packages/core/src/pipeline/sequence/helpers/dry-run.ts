/**
 * Driving the enrollment machine for a dry run.
 *
 * The runner will do exactly this and then perform the effect; the only
 * difference is what happens to the `SequenceEffect` the machine leaves behind.
 * A dry run stops at the claim request, because claiming is the runner's job and
 * the runner is what does not exist yet.
 *
 * It lives in core so that the CLI does not need the state library at all. A
 * consumer that wants to know what a tick would do asks this function; how the
 * answer is computed is core's business, and a second implementation of the same
 * transition in a caller is a second set of bugs.
 */

import { createActor } from "xstate";
import { createEnrollmentMachine } from "../machine.ts";
import { nextAllowedSendAt, quietHoursWindow, timeZoneForNumber } from "./quiet-hours.ts";
import type { EligibilityEvaluator, SequenceEffect } from "../types.ts";

export interface DryRunRecipient {
  id: string;
  to?: string | null;
  country?: string | null;
  stateCode?: string | null;
  doNotContact?: boolean;
  hasReplied?: boolean;
  sentInLastDay?: number;
  /** Profile bound to the sending number, which wins over the country map. */
  numberProfileId?: string | null;
}

export interface DryRunResult {
  /** The state the enrollment would rest in after one tick. */
  state: string;
  /** The effect the machine asked the runner to perform. */
  effect: SequenceEffect;
  cursor: number;
  status: string;
  claimKey: string;
  timeZone: string | null;
  localHour: number | null;
  quiet: boolean;
  approximateZone: boolean;
  nextAllowedAt: number | null;
  /**
   * The due time the machine settled on. A skip or a quiet-hours defer moves
   * it, so the runner persists this rather than inventing its own retry delay;
   * anything else would be a second, disagreeing scheduling policy.
   */
  nextDueAt: number | null;
  /** Why this recipient would not be sent to, or null when it would. */
  skipReason: string | null;
  skipDetail: string | null;
}

export interface DryRunInput {
  enrollmentId: string;
  sequenceId: string;
  steps: { text: string; delayHours: number; isStop: boolean }[];
  fromNumber: string;
  recipient: DryRunRecipient;
  now: number;
  evaluate: EligibilityEvaluator;
  /**
   * Persisted enrollment state, for driving a real enrollment rather than a
   * hypothetical one. Absent means a fresh enrollment at cursor 0. The runner
   * passes the row; the CLI preview omits it. Same machine, same transitions.
   */
  persisted?: {
    cursor: number;
    status: "active" | "paused";
    nextDueAt: number | null;
    lastSentAt: number | null;
    attempts: number;
    lastSkipReason: string | null;
  };
}

/**
 * One tick of the real machine over one recipient.
 *
 * Nothing is sent, nothing is claimed, and nothing is persisted. The returned
 * state is the machine's own answer, not a reimplementation of its transitions.
 */
export function dryRunEnrollment(input: DryRunInput): DryRunResult {
  const { timeZone, approximate } = timeZoneForNumber(
    input.recipient.to ?? null,
    input.recipient.stateCode ?? null,
  );
  const window = quietHoursWindow(timeZone, input.now, approximate);

  const persisted = input.persisted;
  const actor = createActor(createEnrollmentMachine(), {
    input: {
      enrollmentId: input.enrollmentId,
      sequenceId: input.sequenceId,
      cursor: persisted?.cursor ?? 0,
      steps: input.steps,
      fromNumber: input.fromNumber,
      to: input.recipient.to ?? null,
      country: input.recipient.country ?? null,
      timeZone,
      approximateZone: approximate,
      nextDueAt: persisted?.nextDueAt ?? null,
      lastSentAt: persisted?.lastSentAt ?? null,
      status: persisted?.status ?? "active",
      attempts: persisted?.attempts ?? 0,
      lastSkipReason: persisted?.lastSkipReason ?? null,
      evaluate: input.evaluate,
      nextAllowedSendAt: (from) => nextAllowedSendAt(timeZone, from, approximate),
      now: input.now,
      sentInLastDay: input.recipient.sentInLastDay ?? 0,
      doNotContact: input.recipient.doNotContact === true,
      hasReplied: input.recipient.hasReplied === true,
      numberProfileId: input.recipient.numberProfileId ?? null,
    },
  });
  actor.start();
  actor.send({ type: "TICK", at: input.now });
  const snapshot = actor.getSnapshot();
  const result: DryRunResult = {
    state: String(snapshot.value),
    effect: snapshot.context.pendingEffect,
    cursor: snapshot.context.cursor,
    status: snapshot.context.status,
    claimKey: snapshot.context.claimKey,
    timeZone,
    localHour: window.localHour,
    quiet: window.quiet,
    approximateZone: approximate,
    nextAllowedAt: window.quiet ? nextAllowedSendAt(timeZone, input.now, approximate) : input.now,
    /**
     * The due time the machine settled on. A skip or a quiet-hours defer moves
     * it, so the runner persists this rather than inventing its own retry
     * delay; anything else would be a second, disagreeing scheduling policy.
     */
    nextDueAt: snapshot.context.nextDueAt,
    skipReason: snapshot.context.lastSkipReason,
    skipDetail: null,
  };
  actor.stop();
  return result;
}
