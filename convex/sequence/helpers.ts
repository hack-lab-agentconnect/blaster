import type { QueryCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { normaliseCountry } from "../../packages/core/src/telnyx/messaging/helpers/profile.js";
import {
  conversationPairKey,
  normalizePhoneNumber,
} from "../../packages/core/src/conversation/history/helpers/pair.js";
import type { RunContext } from "./types.js";
import { stepsInOrder } from "./utils.js";

/**
 * Context-bound reads for the sequence domain.
 *
 * Convex actions have no direct database access, so the runner reaches data
 * through a query. Putting the read logic here rather than inline in the action
 * means there is one implementation of "what does this step's decision rest on",
 * and the query in `queries.ts` stays a thin boundary over it.
 *
 * These functions take Convex's own `QueryCtx` rather than a hand-written
 * subset of it. A narrower structural type reads as tidier but stops the
 * compiler from knowing which table a document id belongs to, which in turn
 * makes the table name inexplicit at every `db.get` and hides real mismatches
 * behind `any`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ids worth considering this tick.
 *
 * Ids rather than rows, so nothing downstream can act on a snapshot it cannot
 * revalidate: the runner re-reads each enrollment immediately before sending.
 */
export async function dueEnrollmentIds(
  ctx: QueryCtx,
  now: number,
  limit = 25,
): Promise<Id<"sequenceEnrollments">[]> {
  const rows = await ctx.db
    .query("sequenceEnrollments")
    .withIndex("statusNextDueAt", (q: any) => q.eq("status", "active").lte("nextDueAt", now))
    .take(limit);
  return rows.map((row) => row._id);
}

/**
 * Assemble everything one step's decision rests on, from one snapshot.
 *
 * `stopOnReply` is enforced from the stored thread rather than from the
 * enrollment's status, so a sequence that should stop on a reply cannot keep
 * sending to someone who answered even if the status has not caught up.
 */
export async function loadRunContext(
  ctx: QueryCtx,
  enrollmentId: Id<"sequenceEnrollments">,
  now: number,
): Promise<RunContext | null> {
  const enrollment = await ctx.db.get("sequenceEnrollments", enrollmentId);
  if (!enrollment) return null;
  const sequence = await ctx.db.get("sequences", enrollment.sequenceId);
  if (!sequence) return null;

  // The steps of the one sequence this enrollment points at. Bounded by that
  // sequence's own step count, which the caller wrote when it defined the steps.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const stepRows = await ctx.db
    .query("sequenceSteps")
    .withIndex("sequenceId", (q: any) => q.eq("sequenceId", sequence._id))
    .collect();
  const steps = stepsInOrder(stepRows);

  // messagingProfiles is a bounded config table: one row per country the
  // deployment sends from, so the whole set is what eligibility needs.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const profileRows = await ctx.db.query("messagingProfiles").collect();
  const profilePairs = profileRows
    .filter((row: any) => row.active && row.profileId)
    .map((row: any) => ({ country: normaliseCountry(row.country), profileId: row.profileId }));

  const to = enrollment.to ? normalizePhoneNumber(enrollment.to) : "";
  let sentInLastDay = 0;
  let hasReplied = false;

  if (to) {
    // The index range already bounds this to the last DAY_MS of messages to one
    // recipient, so the collect reads a day's slice rather than the table.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const recent = await ctx.db
      .query("messages")
      .withIndex("to", (q: any) => q.eq("to", to).gte("sentAt", now - DAY_MS))
      .collect();
    sentInLastDay = recent.filter(
      (message: any) => message.direction === "outbound" && message.sentAt >= now - DAY_MS,
    ).length;

    // `to` is truthy here, so enrollment.to is too; the fallback is only there
    // to give the compiler the narrowing `if (to)` cannot infer from a field.
    const pairKey = conversationPairKey(normalizePhoneNumber(enrollment.to ?? ""), to);
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("pairKey", (q: any) => q.eq("pairKey", pairKey))
      .unique();
    if (conversation) {
      // The whole thread, because "has this contact ever replied" cannot be
      // narrowed to a range: a reply may be older than any window worth reading,
      // and treating a missed old reply as no reply is how a stopOnReply
      // sequence keeps sending. Bounded by one thread's length.
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      const thread = await ctx.db
        .query("messages")
        .withIndex("conversation", (q: any) => q.eq("conversationId", conversation._id))
        .collect();
      hasReplied = thread.some((message: any) => message.direction === "inbound");
    }
  }

  return {
    enrollment: {
      _id: enrollment._id,
      sequenceId: enrollment.sequenceId,
      recipientId: enrollment.recipientId,
      to: enrollment.to,
      country: enrollment.country,
      ownerMemberId: enrollment.ownerMemberId,
      cursor: enrollment.cursor,
      status: enrollment.status,
      enrolledAt: enrollment.enrolledAt,
      nextDueAt: enrollment.nextDueAt,
      lastSentAt: enrollment.lastSentAt,
      lastSkipReason: enrollment.lastSkipReason,
      attempts: enrollment.attempts,
      doNotContact: enrollment.doNotContact,
    },
    sequence: {
      _id: sequence._id,
      name: sequence.name,
      status: sequence.status,
      fromNumber: sequence.fromNumber,
      numberProfileId: sequence.numberProfileId,
      poolId: sequence.poolId,
      options: sequence.options,
    },
    steps,
    profilePairs,
    sentInLastDay,
    hasReplied,
  };
}
