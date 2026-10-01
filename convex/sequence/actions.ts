"use node";

import { v } from "convex/values";
// Aliased: `profileEnv` below builds the Telnyx SDK's own env record and this
// handler holds it in a local `env`, which would otherwise shadow the Convex
// one for the rest of the function.
import { internalAction, env as convexEnv } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import {
  dryRunEnrollment,
  evaluateEligibility,
  type EligibilityInput,
} from "../../packages/core/src/pipeline/sequence/index";
import {
  TelnyxError,
  classifySendError,
  classifySendResult,
  resolveMessagingProfile,
  sendMessage,
} from "../../packages/core/src/telnyx/messaging/index";
import type { ApplyScheduleArgs, RunOutcome } from "./index.js";
import { isScheduledStatus, profileEnv } from "./utils.js";

/**
 * The sequence runner.
 *
 * This is the only code that sends on a schedule, and it is deliberately thin.
 * Every decision — eligible, quiet hours, claim key, retry ceiling, what an
 * unknown outcome means — belongs to the state machine in packages/core. This
 * file loads rows, asks the machine what to do, performs the one effect it
 * asked for, and reports the result back. A rule that appears here instead of
 * there is a second implementation of the lifecycle, which is the failure mode
 * this design exists to prevent.
 *
 * Why an action and not a mutation: Telnyx is a network call and the SDK uses
 * Node APIs, so this file declares the Node runtime. Mutations are serialisable
 * transactions and must not await the outside world, so every state change a
 * send causes is made through a mutation instead.
 *
 * Claim-before-send is enforced twice, deliberately. `claimStep` decides who
 * owns the step, and the enrollment is re-read immediately after the claim
 * lands: cancellation cannot interrupt an in-flight action, so an enrollment
 * that a reply stopped a moment ago has to be caught before the request is
 * built rather than apologised for afterwards.
 *
 * No type is written inline here. Shapes come from the domain's `types.ts` via
 * its barrel (R11/R12), which is why there is no `as` cast at the call sites
 * below: if a shape is missing, the compiler says so and the fix belongs in one
 * place.
 */

/** Run one enrollment for one step. A manual run can target a single id. */
export const runEnrollmentStep = internalAction({
  args: { enrollmentId: v.id("sequenceEnrollments"), now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<RunOutcome> => {
    const now = args.now ?? Date.now();
    const loaded = await ctx.runQuery(internal.sequence.queries.loadRunContext, {
      enrollmentId: args.enrollmentId,
      now,
    });
    if (!loaded) return { kind: "sentinel", reason: "unknown-enrollment-or-sequence" };

    const { enrollment, sequence, steps } = loaded;
    if (enrollment.status !== "active") {
      return { kind: "sentinel", reason: `enrollment-${enrollment.status}` };
    }
    if (sequence.status !== "active") {
      return { kind: "sentinel", reason: `sequence-${sequence.status}` };
    }

    const step = steps[enrollment.cursor];

    // The cursor reached the stop step or ran off the end, so the sequence is
    // done. Reaching a stop means "do not send", so it must never become one.
    if (!step || step.isStop) {
      await ctx.runMutation(internal.sequence.mutations.completeEnrollment, {
        enrollmentId: enrollment._id,
      });
      return { kind: "sentinel", reason: "sequence-complete" };
    }

    const env = profileEnv(loaded.profilePairs);
    const evaluate = (recipient: EligibilityInput) => {
      const verdict = evaluateEligibility(env, sequence.options, {
        id: enrollment.recipientId,
        to: recipient.to,
        country: recipient.country,
        doNotContact: recipient.doNotContact,
        hasReplied: recipient.hasReplied,
        sentInLastDay: recipient.sentInLastDay,
        numberProfileId: sequence.numberProfileId ?? null,
      });
      return { eligible: verdict.eligible, reason: verdict.reason, detail: verdict.detail };
    };

    const decision = dryRunEnrollment({
      enrollmentId: enrollment._id,
      sequenceId: sequence._id,
      steps,
      fromNumber: sequence.fromNumber,
      recipient: {
        id: enrollment.recipientId,
        to: enrollment.to ?? null,
        country: enrollment.country ?? null,
        doNotContact: enrollment.doNotContact === true,
        hasReplied: loaded.hasReplied,
        sentInLastDay: loaded.sentInLastDay,
        numberProfileId: sequence.numberProfileId ?? null,
      },
      now,
      evaluate,
      persisted: {
        cursor: enrollment.cursor,
        // Already narrowed to "active" by the guard above; the persisted shape
        // accepts a pause for the manual-resume path.
        status: "active",
        nextDueAt: enrollment.nextDueAt ?? null,
        lastSentAt: enrollment.lastSentAt ?? null,
        attempts: enrollment.attempts ?? 0,
        lastSkipReason: enrollment.lastSkipReason ?? null,
      },
    });

    // Nothing owed right now. Persist the machine's own schedule so the skip,
    // the quiet-hours defer, and the unplaceable park all land as it decided
    // rather than as this file guesses.
    if (decision.effect.type === "none") {
      if (!isScheduledStatus(decision.status)) {
        // The machine reported a state a reschedule may not write, which means
        // it decided something other than a schedule. Left alone, the row keeps
        // its due time and comes back next tick; forcing a status here would be
        // the runner inventing a transition the machine never made.
        return { kind: "sentinel", reason: `unwritable-status-${decision.status}` };
      }
      const schedule: ApplyScheduleArgs = {
        enrollmentId: enrollment._id,
        status: decision.status,
        nextDueAt: decision.nextDueAt ?? undefined,
        lastSkipReason: decision.skipReason ?? undefined,
        attempts: enrollment.attempts ?? 0,
      };
      await ctx.runMutation(internal.sequence.mutations.applySchedule, schedule);
      return { kind: "sentinel", reason: decision.skipReason ?? "not-due" };
    }

    const claim = await ctx.runMutation(internal.sequence.mutations.claimStep, {
      enrollmentId: enrollment._id,
      cursor: enrollment.cursor,
    });
    if (!claim.claimed) {
      return { kind: "not-claimed", reason: claim.reason ?? "lost" };
    }

    // Re-read after the claim. The webhook that stopped this sequence runs in
    // its own transaction and cannot interrupt an action, so the only safe
    // place to notice is between winning the claim and building the request.
    const recheck = await ctx.runQuery(internal.sequence.queries.loadRunContext, {
      enrollmentId: enrollment._id,
      now,
    });
    if (!recheck || recheck.enrollment.status !== "active") {
      return { kind: "not-claimed", reason: "stopped-during-claim" };
    }
    if (recheck.enrollment.cursor !== enrollment.cursor) {
      return { kind: "not-claimed", reason: "cursor-moved" };
    }
    if (recheck.hasReplied) {
      // The person answered. A `stopOnReply` sequence must not send again.
      await ctx.runMutation(internal.sequence.mutations.recordStep, {
        enrollmentId: enrollment._id,
        outcome: "replied",
        steps,
      });
      return { kind: "sentinel", reason: "replied-before-send" };
    }

    // Typed, so a typo in the variable name is a build error. The guard stays
    // even though `convexEnv.TELNYX_API_KEY` is declared required: parking the
    // enrollment with a readable reason beats throwing an opaque error out of
    // the runner if the deployment is ever provisioned without it.
    const apiKey = convexEnv.TELNYX_API_KEY;
    if (!apiKey) {
      // Nothing was sent, so this is a definite failure rather than an unknown
      // outcome: it parks after the retry ceiling instead of being guessed at.
      await ctx.runMutation(internal.sequence.mutations.recordStep, {
        enrollmentId: enrollment._id,
        outcome: "failed",
        steps,
        skipReason: "missing-telnyx-api-key",
      });
      return { kind: "failed", retryable: false, reason: "missing-telnyx-api-key" };
    }

    const to = decision.effect.type === "send" ? decision.effect.to : enrollment.to ?? null;
    if (!to) {
      await ctx.runMutation(internal.sequence.mutations.recordStep, {
        enrollmentId: enrollment._id,
        outcome: "skipped",
        steps,
        skipReason: "no-number",
      });
      return { kind: "sentinel", reason: "no-number" };
    }

    let outcome: RunOutcome;
    // The profile the eligibility check already accepted, resolved the same way
    // rather than by a second independent decision.
    const profile = resolveMessagingProfile(env, {
      to,
      recipientCountry: enrollment.country ?? null,
      numberProfileId: sequence.numberProfileId ?? null,
    });
    try {
      const sent = await sendMessage({
        apiKey,
        from: sequence.fromNumber,
        to,
        text: step.text,
        messagingProfileId: profile.profileId ?? "",
      });
      outcome = classifySendResult({ ok: true, status: 200, messageId: sent.id });
    } catch (error) {
      // A throw carrying an HTTP status is a decision Telnyx made; anything
      // else never learned the outcome at all. Only the first may be "failed".
      outcome =
        error instanceof TelnyxError
          ? classifySendResult({ ok: false, status: error.status, detail: error.message })
          : classifySendError(error);
    }

    if (outcome.kind === "sent") {
      await ctx.runMutation(internal.sequence.mutations.recordStep, {
        enrollmentId: enrollment._id,
        outcome: "sent",
        steps,
        message: {
          to,
          from: sequence.fromNumber,
          text: step.text,
          telnyxMessageId: outcome.messageId,
          sentAt: now,
        },
      });
      return { kind: "sent", messageId: outcome.messageId };
    }

    if (outcome.kind === "failed") {
      await ctx.runMutation(internal.sequence.mutations.recordStep, {
        enrollmentId: enrollment._id,
        outcome: "failed",
        steps,
        skipReason: outcome.reason,
      });
      return { kind: "failed", retryable: outcome.retryable, reason: outcome.reason };
    }

    // Unknown whether it went out. Park it; only a human reconcile moves it.
    await ctx.runMutation(internal.sequence.mutations.recordStep, {
      enrollmentId: enrollment._id,
      outcome: "ambiguous",
      steps,
      skipReason: outcome.reason,
    });
    return { kind: "ambiguous", reason: outcome.reason };
  },
});

/**
 * Drain the due queue once.
 *
 * Sequential on purpose. Convex actions are unbounded, but these sends share
 * one Telnyx account and one messaging profile, so a wide fan-out would turn a
 * rate-limit rejection into a burst of ambiguous outcomes, each one parked for
 * a human. Bounded work per tick is the difference between a backlog and an
 * outage.
 */
export const runDueEnrollments = internalAction({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  // Annotated rather than inferred. Without it TypeScript has to infer this
  // action's type from the body, the body mentions the other actions in this
  // same module through `internal`, and the result is a circular definition it
  // reports as TS7022/TS7023 rather than resolving. The annotation is the
  // documented way to break that cycle.
  handler: async (
    ctx,
    args,
  ): Promise<{
    now: number;
    considered: number;
    results: Array<{ enrollmentId: string; outcome: RunOutcome }>;
  }> => {
    const now = args.now ?? Date.now();
    const ids = await ctx.runQuery(internal.sequence.queries.runDueEnrollmentIds, {
      now,
      limit: args.limit,
    });

    const results: Array<{ enrollmentId: string; outcome: RunOutcome }> = [];
    for (const enrollmentId of ids) {
      const outcome = await ctx.runAction(internal.sequence.actions.runEnrollmentStep, {
        enrollmentId,
        now,
      });
      results.push({ enrollmentId, outcome });
    }
    return { now, considered: ids.length, results };
  },
});
