import { defineTable } from "convex/server";
import { v } from "convex/values";
import { enrollmentStatusValidator } from "../sequence/types.js";

/** Tables for message sequences and enrollment state. */
export const sequenceTables = {
  /**
   * A message sequence: a sending number, an optional campaign, a set of
   * options, and an ordered list of steps held in sequenceSteps.
   */
  sequences: defineTable({
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("completed"),
    ),
    /** Sending number in E.164. Falls back when no pool is assigned. */
    fromNumber: v.string(),
    /**
     * When set, the sending number is chosen from this pool per send instead of
     * the fixed `fromNumber`, so the pool's ordering and per-number rate budget
     * govern the send. Absent keeps the single-number behaviour.
     */
    poolId: v.optional(v.id("pools")),
    /** Profile bound to that number, which outranks the country rule. */
    numberProfileId: v.optional(v.string()),
    /** Twenty campaign this sequence belongs to. */
    campaignId: v.optional(v.string()),
    /** How many steps the sequence has, so a runner can size a batch. */
    stepCount: v.number(),
    options: v.object({
      stopOnReply: v.boolean(),
      respectDoNotContact: v.boolean(),
      requireProfileForCountry: v.boolean(),
      dailyCapPerRecipient: v.number(),
    }),
    createdAt: v.number(),
  })
    .index("status", ["status"])
    .index("campaignId", ["campaignId"])
    // Resolving a conversation's campaign means finding the sequence that sent
    // from this number, so the inbox's per-number grouping can start here.
    .index("fromNumber", ["fromNumber"])
    // Newest first, which is the order `listSequences` reports in. Without it
    // that query read the whole table and sorted in memory, so its cost grew
    // with every sequence ever created rather than with the page it returned.
    .index("createdAt", ["createdAt"]),

  /** One step of a sequence, ordered by `order`. */
  sequenceSteps: defineTable({
    sequenceId: v.id("sequences"),
    order: v.number(),
    text: v.string(),
    delayHours: v.number(),
    isStop: v.boolean(),
  }).index("sequenceId", ["sequenceId"]),

  /** A prospect enrolled in a sequence, with its position and next due time. */
  sequenceEnrollments: defineTable({
    sequenceId: v.id("sequences"),
    /** Twenty prospect id, so the workspace stays the system of record. */
    recipientId: v.string(),
    to: v.optional(v.string()),
    country: v.optional(v.string()),
    /**
     * The workspace member responsible for this enrollment, recorded at enroll
     * time from the operator's actor. Inbound notifications for this enrollment
     * go to this member rather than to every member with a Bark key: the
     * routing lives in the record, not outside the workflow. Absent means no
     * member was signed in at enroll time, and notifications fall back to all
     * members with a key.
     */
    ownerMemberId: v.optional(v.string()),
    /** Index of the next step to consider. */
    cursor: v.number(),
    // The one definition of an enrollment's states lives in the sequence
    // domain's types.ts, so the schema cannot accept a state the domain's code
    // does not know about, or reject one it writes.
    status: enrollmentStatusValidator,
    enrolledAt: v.number(),
    nextDueAt: v.optional(v.number()),
    lastSentAt: v.optional(v.number()),
    /** Set when a send was skipped, so an operator can see why. */
    lastSkipReason: v.optional(v.string()),
    /**
     * Consecutive failed attempts at the current step. The machine's retry
     * ceiling only means something across restarts if the count is persisted:
     * an in-memory counter would reset on every tick and retry forever.
     */
    attempts: v.optional(v.number()),
    /**
     * Do-not-contact as it stood when the prospect was enrolled.
     *
     * Convex holds no Twenty credentials, so it cannot ask whether a flag has
     * been raised since. The snapshot is what the runner enforces, and a later
     * change must reach the runner through the inbound opt-out path or a
     * re-enroll. Snapshotted rather than guessed so the runner has a definite
     * answer instead of defaulting to "not DNC".
     */
    doNotContact: v.optional(v.boolean()),
  })
    .index("sequenceId", ["sequenceId"])
    .index("nextDueAt", ["nextDueAt"])
    // The runner's only queue read: active and already due, in one index range.
    // Status first, then the range, so `dueEnrollments` never scans the table —
    // a full collect here would grow past Convex's read limits as enrollments
    // accumulate, and a runner that cannot read its queue stops all sending.
    //
    // This index also answers any `status`-only query by constraining its first
    // field, which is why there is no separate "status" index: a shorter index
    // over a prefix of these would return the same rows while every insert and
    // update wrote another copy of the table.
    .index("statusNextDueAt", ["status", "nextDueAt"])
    // E.164 recipient, matching the conversation's peer number. A thread can
    // exist before anyone enrolls the contact, so this resolves a campaign for
    // the threads that have one and returns nothing for the rest, which is the
    // honest answer rather than a guess.
    .index("to", ["to"]),

  /**
   * One claim per owed step, enforcing claim-before-send.
   *
   * The key is `enrollmentId:cursor`, derived rather than generated, so two
   * runs of the same step collide by construction. Uniqueness is enforced by
   * the compound index plus an insert-time check inside one mutation: a second
   * claim for the same step finds the existing row and loses, which is what
   * stops the duplicate send. Claim rows are never deleted; they are the audit
   * trail of what was attempted.
   */
  sequenceSendClaims: defineTable({
    enrollmentId: v.id("sequenceEnrollments"),
    cursor: v.number(),
    claimedAt: v.number(),
  }).index("enrollmentCursor", ["enrollmentId", "cursor"]),
};
