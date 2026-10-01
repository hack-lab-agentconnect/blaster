/**
 * Sequence building and eligibility.
 *
 * A sequence is a phone number, a campaign, a set of options, and an ordered
 * list of steps. Everything here is a pure function over plain data, so the
 * rules that decide whether a message may go out are tested with no provider,
 * no workspace, and no deployment.
 *
 * Three rules carry the weight, and each exists because the alternative is a
 * message that cannot legally be sent or should not have been:
 *
 *   1. The recipient's jurisdiction decides the messaging profile. A country
 *      with no registered profile is skipped rather than sent from the default,
 *      because the carrier rejects it after Telnyx has already accepted it.
 *   2. A do-not-contact prospect is never sent to, regardless of options.
 *   3. A reply stops the sequence. Continuing to send after a person answers is
 *      the failure that costs a number its reputation.
 */

import { normaliseCountry, resolveMessagingProfile, type MessagingProfileEnv, type ProfileResolution } from "../../../telnyx/messaging/helpers/profile.ts";
import type { EnrollmentStatus } from "../types.ts";

export type SequenceStatus = "draft" | "active" | "paused" | "completed";

export interface SequenceOptions {
  /** Stop sending as soon as the recipient replies. Default true. */
  stopOnReply: boolean;
  /** Never send to a prospect marked do-not-contact. Default true, and not disableable. */
  respectDoNotContact: boolean;
  /**
   * Skip a recipient whose country has no registered messaging profile instead
   * of falling back to the default. Default true.
   */
  requireProfileForCountry: boolean;
  /** Ceiling on messages per recipient per day. 0 disables the cap. */
  dailyCapPerRecipient: number;
}

export const DEFAULT_OPTIONS: SequenceOptions = {
  stopOnReply: true,
  respectDoNotContact: true,
  requireProfileForCountry: true,
  dailyCapPerRecipient: 0,
};

export interface SequenceStepDraft {
  /** Message body. Kept verbatim: templating is the caller's decision. */
  text: string;
  /** Hours to wait before this step. The first step is normally 0. */
  delayHours: number;
  /** When true, reaching this step ends the sequence instead of sending. */
  isStop: boolean;
}

export interface SequenceDraft {
  name: string;
  /** Sending number in E.164. */
  fromNumber: string;
  /** Profile bound to that number, when the operator set one. */
  numberProfileId?: string;
  /** Twenty campaign this sequence belongs to, when there is one. */
  campaignId?: string;
  options: SequenceOptions;
  steps: SequenceStepDraft[];
}

export type DraftProblem =
  | { field: string; problem: string };

/**
 * Validate a draft before it is persisted.
 *
 * Returns the problems rather than throwing, because a builder collects several
 * at once and a caller wants to show all of them.
 */
export function validateDraft(draft: SequenceDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];

  if (!draft.name.trim()) problems.push({ field: "name", problem: "A sequence needs a name." });
  if (!/^\+?[1-9]\d{6,14}$/.test(draft.fromNumber.trim())) {
    problems.push({ field: "fromNumber", problem: "Sending number must be E.164, for example +353871234567." });
  }
  if (draft.steps.length === 0) {
    problems.push({ field: "steps", problem: "A sequence needs at least one step." });
  }

  draft.steps.forEach((step, index) => {
    if (step.isStop) return;
    if (!step.text.trim()) {
      problems.push({ field: `steps[${index}]`, problem: "A sending step needs a message body." });
    }
    if (!Number.isFinite(step.delayHours) || step.delayHours < 0) {
      problems.push({ field: `steps[${index}].delayHours`, problem: "Delay cannot be negative." });
    }
  });

  // The first sending step has to be immediate, or the sequence opens with a wait
  // that the operator did not ask for.
  const firstSending = draft.steps.find((step) => !step.isStop);
  if (firstSending && firstSending.delayHours !== 0) {
    problems.push({ field: "steps[0].delayHours", problem: "The first sending step must have a delay of 0." });
  }

  if (draft.options.dailyCapPerRecipient < 0 || !Number.isInteger(draft.options.dailyCapPerRecipient)) {
    problems.push({ field: "options.dailyCapPerRecipient", problem: "Daily cap must be a whole number, or 0 for no cap." });
  }

  return problems;
}

/** A recipient as the sequence rules need to see them. */
export interface Recipient {
  id: string;
  /** Phone number in E.164, when known. */
  to?: string | null;
  country?: string | null;
  /**
   * USPS state code from the number's area code, when it resolved to one.
   *
   * Present for the runner and the dry run rather than for these rules: quiet
   * hours are a wall-clock window in the *recipient's* zone, and the area code is
   * how that zone is reached without asking the prospect. See
   * `helpers/quiet-hours.ts`.
   */
  stateCode?: string | null;
  doNotContact?: boolean;
  /** Set when the prospect has answered. */
  hasReplied?: boolean;
  /** Messages already sent to this recipient in the last 24 hours. */
  sentInLastDay?: number;
  /**
   * The profile bound to the sending number, from the Twenty phone row. It
   * takes precedence over the country map, so an operator's explicit binding
   * is not overridden by a missing country entry.
   */
  numberProfileId?: string | null;
}

export type SkipReason =
  | "do-not-contact"
  | "already-replied"
  | "no-number"
  | "no-profile-for-country"
  | "daily-cap-reached"
  | "no-step-due";

export interface Eligibility {
  eligible: boolean;
  reason: SkipReason | null;
  /** The profile this send would use, when it is allowed to send. */
  profile: ProfileResolution | null;
  /** Why it was skipped, in words, so the caller can show it. */
  detail: string | null;
}

/**
 * Decide whether the next step may be sent to this recipient right now.
 *
 * The order matters. Do-not-contact is checked before anything that could
 * succeed, so an opt-out is never downgraded into a profile problem.
 */
export function evaluateEligibility(
  env: MessagingProfileEnv,
  options: SequenceOptions,
  recipient: Recipient,
): Eligibility {
  if (recipient.doNotContact) {
    return { eligible: false, reason: "do-not-contact", profile: null, detail: "Prospect is marked do-not-contact." };
  }
  if (options.stopOnReply && recipient.hasReplied) {
    return { eligible: false, reason: "already-replied", profile: null, detail: "Prospect already replied, so the sequence stops." };
  }
  if (!recipient.to || !recipient.to.trim()) {
    return { eligible: false, reason: "no-number", profile: null, detail: "Prospect has no phone number." };
  }

  const profile = resolveMessagingProfile(env, {
    to: recipient.to,
    recipientCountry: recipient.country,
    numberProfileId: recipient.numberProfileId ?? null,
  });
  const country = profile.country ?? normaliseCountry(recipient.to);

  if (options.requireProfileForCountry && profile.reason === "default-fallback" && country) {
    return {
      eligible: false,
      reason: "no-profile-for-country",
      profile,
      detail: `No messaging profile is registered for ${country}, so this send would be rejected by the carrier.`,
    };
  }
  if (!profile.profileId) {
    return {
      eligible: false,
      reason: "no-profile-for-country",
      profile,
      detail: "No messaging profile is configured, so nothing can be sent.",
    };
  }

  const cap = options.dailyCapPerRecipient;
  if (cap > 0 && (recipient.sentInLastDay ?? 0) >= cap) {
    return {
      eligible: false,
      reason: "daily-cap-reached",
      profile,
      detail: `Recipient has already received ${recipient.sentInLastDay} messages in the last day, and the cap is ${cap}.`,
    };
  }

  return { eligible: true, reason: null, profile, detail: null };
}

/**
 * An enrolled prospect's position in a sequence.
 *
 * Status is the shared `EnrollmentStatus`, not a second inline union: the
 * machine produces `ambiguous` and `awaiting-human`, and a copy of the union
 * here would reject exactly the states the machine needs persisted.
 */
export interface Enrollment {
  id: string;
  sequenceId: string;
  recipientId: string;
  /** Index of the next step to consider. */
  cursor: number;
  status: EnrollmentStatus;
  enrolledAt: number;
  /** When the current step became due, or null once the sequence is finished. */
  nextDueAt: number | null;
  lastSentAt: number | null;
}

const HOUR_MS = 3_600_000;

/**
 * When the step at `cursor` is due, given when the sequence started.
 *
 * Step delays are relative to the start of the sequence rather than to the
 * previous send, so editing a middle step cannot silently shift every later
 * message for everyone already enrolled.
 */
export function dueAtForStep(steps: SequenceStepDraft[], cursor: number, enrolledAt: number): number | null {
  const step = steps[cursor];
  if (!step) return null;
  return enrolledAt + step.delayHours * HOUR_MS;
}

/** Recompute the next due time after a successful send at `sentAt`. */
export function advance(
  steps: SequenceStepDraft[],
  enrollment: Enrollment,
  sentAt: number,
): Pick<Enrollment, "cursor" | "status" | "nextDueAt" | "lastSentAt"> {
  const nextCursor = enrollment.cursor + 1;
  const reachedEnd = nextCursor >= steps.length;
  const reachedStop = steps[nextCursor]?.isStop === true;

  if (reachedEnd || reachedStop) {
    return { cursor: nextCursor, status: "completed", nextDueAt: null, lastSentAt: sentAt };
  }
  return {
    cursor: nextCursor,
    status: "active",
    nextDueAt: sentAt + (steps[nextCursor]?.delayHours ?? 0) * HOUR_MS,
    lastSentAt: sentAt,
  };
}

/** The text a given step would send, for previews and dry runs. */
export function stepText(steps: SequenceStepDraft[], cursor: number): string | null {
  const step = steps[cursor];
  return step && !step.isStop ? step.text : null;
}

export function summarise(draft: SequenceDraft): {
  steps: number;
  sendingSteps: number;
  stopStep: boolean;
  spanHours: number;
  firstStepHours: number;
  lastStepHours: number;
} {
  const sending = draft.steps.filter((step) => !step.isStop);
  const delays = sending.map((step) => step.delayHours);
  return {
    steps: draft.steps.length,
    sendingSteps: sending.length,
    stopStep: draft.steps.some((step) => step.isStop),
    spanHours: delays.length > 0 ? Math.max(...delays) : 0,
    firstStepHours: delays[0] ?? 0,
    lastStepHours: delays.length > 0 ? (delays[delays.length - 1] as number) : 0,
  };
}
