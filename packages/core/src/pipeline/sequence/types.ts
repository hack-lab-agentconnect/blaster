/**
 * The sequencer's contract: what one enrollment knows, what can happen to it,
 * and what the machine asks the outside world to do.
 *
 * The machine itself performs no I/O. Every network call it needs is expressed
 * as a `SequenceEffect` left in context, and a runner reads it, performs it, and
 * sends the outcome back as an event. That split is what makes the lifecycle
 * testable with no provider and no deployment, and it is the same split the
 * conversation machine uses with its `classify` actor.
 *
 * The one rule the types exist to enforce: **a send is claimed before it is
 * attempted, and an ambiguous outcome is a state rather than an error.** A
 * timeout after the request was sent tells you nothing about whether it was
 * accepted, and billing fires at submission, so retrying that blind is how a
 * person receives the same message twice.
 */

/** How many times one step may be retried before the enrollment is parked. */
export const MAX_STEP_ATTEMPTS = 3;

/**
 * Backoff before a retry, by attempt number.
 *
 * A provider 5xx is usually a blip, and a 1-minute gap would put every
 * enrollment in the queue in lockstep and hammer it again on the next tick.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

/**
 * How long a step waits after being skipped as ineligible before being
 * reconsidered.
 *
 * A skip does not advance the cursor, so without this the runner would re-evaluate
 * the same owed step on every tick, forever. The wait is what makes "the step
 * is still owed" compatible with "the runner polls every minute".
 */
export const SKIP_RETRY_MS = 60 * 60_000;

/**
 * The state stored for an enrollment.
 *
 * `active` covers every in-flight phase; the rest are the states worth waking a
 * human for. `ambiguous` is the reason this union has a member the old status
 * set did not: an enrollment whose last send may or may not have gone out is
 * not `active`, because resuming it automatically is what produces the duplicate.
 */
export type EnrollmentStatus =
  | "active"
  | "replied"
  | "opted-out"
  | "paused"
  | "completed"
  | "failed"
  | "ambiguous"
  | "awaiting-human";

/** What the machine needs the runner to do next. Never performed here. */
export type SequenceEffect =
  | {
      type: "claim";
      /** The deterministic business key for this step. */
      key: string;
    }
  | {
      type: "send";
      /** The same key the claim was taken under, passed to the provider. */
      key: string;
      to: string | null;
      fromNumber: string;
      text: string;
    }
  | { type: "none" };

/**
 * The view of a recipient the eligibility rules need.
 *
 * Deliberately narrower than the `Recipient` the caller holds: these are the
 * only facts a send decision may depend on, so adding a field here is a
 * deliberate widening of what can block a message rather than an accident.
 * The id is absent because no rule reads it, and a rule that wanted it would be
 * a rule about a specific prospect rather than about eligibility.
 */
export interface EligibilityInput {
  to: string | null;
  country: string | null;
  doNotContact: boolean;
  hasReplied: boolean;
  sentInLastDay: number;
  /**
   * The messaging profile bound to the sending number. It wins over the
   * country map, so an operator who bound a profile gets sends in countries
   * that have no entry of their own.
   */
  numberProfileId?: string | null;
}

/** Injected so the machine stays pure: it reads no environment and no clock. */
export type EligibilityEvaluator = (recipient: EligibilityInput) => {
  eligible: boolean;
  reason: string | null;
  detail: string | null;
};

/**
 * Injected clock arithmetic.
 *
 * Returns the next instant inside the sending window, or null when that cannot
 * be computed because the recipient could not be placed. Null is not treated as
 * "send anyway": the machine parks the enrollment for a human, because inventing
 * a timestamp for a recipient whose zone is unknown is exactly the kind of
 * guess that produces a 3am send.
 */
export type NextAllowedSendAt = (from: number) => number | null;

export interface EnrollmentMachineInput {
  enrollmentId: string;
  sequenceId: string;
  /** Index of the step currently owed. */
  cursor: number;
  /** The sequence's steps, so the cursor arithmetic has one implementation. */
  steps: { text: string; delayHours: number; isStop: boolean }[];
  fromNumber: string;
  to: string | null;
  country: string | null;
  /** Resolved by the runner from the number. Null when unplaceable. */
  timeZone: string | null;
  /** True when the zone came from a multi-zone state. */
  approximateZone: boolean;
  /** When the owed step became due. Null means due now. */
  nextDueAt: number | null;
  lastSentAt: number | null;
  status: EnrollmentStatus;
  attempts: number;
  lastSkipReason: string | null;
  evaluate: EligibilityEvaluator;
  nextAllowedSendAt: NextAllowedSendAt;
  /** The instant this run is happening, for a test to pin. */
  now: number;
  /** Sent in the last 24h, for the daily cap. */
  sentInLastDay: number;
  doNotContact: boolean;
  hasReplied: boolean;
  /** The profile bound to the sending number, forwarded to eligibility. */
  numberProfileId?: string | null;
}

export type EnrollmentEvent =
  | { type: "TICK"; at: number }
  | { type: "CLAIM_TAKEN"; at: number }
  | { type: "CLAIM_HELD_BY_OTHER" }
  | { type: "SEND_SUCCEEDED"; messageId: string; at: number }
  | { type: "SEND_FAILED"; at: number; retryable: boolean; reason: string }
  | { type: "SEND_AMBIGUOUS"; reason: string }
  | { type: "INBOUND_REPLY" }
  | { type: "OPT_OUT" }
  | { type: "PAUSE" }
  | { type: "RESUME"; at: number }
  | { type: "RECONCILE"; wentOut: boolean; at: number };

/**
 * The business key for one step.
 *
 * Derived from the enrollment and the cursor rather than generated per attempt,
 * so two runs of the same step collide by construction. That collision is the
 * whole duplicate-suppression mechanism: a retry after a timeout presents the
 * same key and is refused.
 */
export function claimKeyFor(enrollmentId: string, cursor: number): string {
  return `${enrollmentId}:${cursor}`;
}
