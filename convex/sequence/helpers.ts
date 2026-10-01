import type { QueryCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { normaliseCountry } from "../../packages/core/src/telnyx/messaging/helpers/profile.js";
import { normalizePhoneNumber } from "../../packages/core/src/conversation/history/helpers/pair.js";
import { isSuppressed } from "../suppressions/model.js";
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
 * Whether this peer has ever written in, on any of our numbers.
 *
 * A reply stops the sequence regardless of which Blaster number received it:
 * `stopEnrollmentsForPeer` is number-agnostic, and a pool sequence has no single
 * sending number to key a pair on anyway. So this asks across every thread the
 * peer has rather than guessing one pair key — the previous fixed pair was built
 * from the peer twice and could never match a real conversation. All the threads
 * for one contact are a handful, so the reads stay bounded.
 */
async function peerHasReplied(ctx: QueryCtx, peer: string): Promise<boolean> {
  if (!peer) return false;
  // One contact's threads: bounded by the Blaster numbers that reached them.
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("phoneNumber", (q: any) => q.eq("phoneNumber", peer))
    .collect();
  for (const conversation of conversations) {
    // The whole thread, because a reply may be older than any window worth
    // reading, and treating a missed old reply as no reply is how a stopOnReply
    // sequence keeps sending. Bounded by one thread's length.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const thread = await ctx.db
      .query("messages")
      .withIndex("conversation", (q: any) => q.eq("conversationId", conversation._id))
      .collect();
    if (thread.some((message: any) => message.direction === "inbound")) return true;
  }
  return false;
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
  }

  const hasReplied = await peerHasReplied(ctx, to);
  // Durable per-person suppression, distinct from the enrollment snapshot: a
  // STOP in another sequence, from another number, must stop this step even
  // before the enrollment's own status catches up. Folded into `doNotContact`
  // so the machine's eligibility rule is unchanged — a suppressed peer is one
  // the eligibility input already knows how to refuse.
  const suppressed = to ? await isSuppressed(ctx, to) : false;

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
      doNotContact: enrollment.doNotContact === true || suppressed,
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
