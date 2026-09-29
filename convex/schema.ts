import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Blaster's own tables.
 *
 * Twenty remains the system of record for leads, calls, and prospects, so none
 * of that is mirrored here. What Blaster owns is the state Twenty cannot
 * represent: which messaging profile a jurisdiction is registered against,
 * which notifications have already been delivered, and the cost ceiling each
 * discovery run is allowed to spend.
 */
export default defineSchema({
  /** A messaging profile registered for one jurisdiction. */
  messagingProfiles: defineTable({
    /** ISO alpha-2, or "DEFAULT" for the catch-all profile. */
    country: v.string(),
    /** Telnyx messaging profile id. */
    profileId: v.string(),
    /** 10DLC brand and campaign backing a US profile. */
    tenDlcCampaignId: v.optional(v.string()),
    /** Alphanumeric sender backing a non-US profile. */
    alphaSender: v.optional(v.string()),
    active: v.boolean(),
  })
    .index("country", ["country"]),

  /**
   * A notification that has been delivered, keyed by the firing set it
   * belonged to, so an unchanged set is not delivered twice.
   */
  notifications: defineTable({
    ruleId: v.string(),
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("critical")),
    message: v.string(),
    /** Identity of the whole firing set at the time of delivery. */
    stateKey: v.string(),
    deliveredAt: v.number(),
    acknowledgedAt: v.optional(v.number()),
  })
    .index("stateKey", ["stateKey"])
    .index("deliveredAt", ["deliveredAt"]),

  /** Cost ceiling and outcome for one discovery run. */
  discoveryRuns: defineTable({
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    maxCostUsd: v.number(),
    spentUsd: v.optional(v.number()),
    prospectsFound: v.optional(v.number()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("startedAt", ["startedAt"]),

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
    /** Sending number in E.164. */
    fromNumber: v.string(),
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
    .index("fromNumber", ["fromNumber"]),

  /** One step of a sequence, ordered by `order`. */
  sequenceSteps: defineTable({
    sequenceId: v.id("sequences"),
    order: v.number(),
    text: v.string(),
    delayHours: v.number(),
    isStop: v.boolean(),
  })
    .index("sequenceId", ["sequenceId"]),

  /** A prospect enrolled in a sequence, with its position and next due time. */
  sequenceEnrollments: defineTable({
    sequenceId: v.id("sequences"),
    /** Twenty prospect id, so the workspace stays the system of record. */
    recipientId: v.string(),
    to: v.optional(v.string()),
    country: v.optional(v.string()),
    /** Index of the next step to consider. */
    cursor: v.number(),
    status: v.union(
      v.literal("active"),
      v.literal("replied"),
      v.literal("opted-out"),
      v.literal("completed"),
      v.literal("paused"),
    ),
    enrolledAt: v.number(),
    nextDueAt: v.optional(v.number()),
    lastSentAt: v.optional(v.number()),
    /** Set when a send was skipped, so an operator can see why. */
    lastSkipReason: v.optional(v.string()),
  })
    .index("sequenceId", ["sequenceId"])
    .index("status", ["status"])
    .index("nextDueAt", ["nextDueAt"])
    // E.164 recipient, matching the conversation's peer number. A thread can
    // exist before anyone enrolls the contact, so this resolves a campaign for
    // the threads that have one and returns nothing for the rest, which is the
    // honest answer rather than a guess.
    .index("to", ["to"]),

  /**
   * Owned Telnyx phone numbers: the purchase ledger Twenty cannot represent.
   *
   * Twenty `agencyPhones` is the operator-visible mirror; this table is the
   * record of what was actually ordered (order id, Telnyx number id, costs,
   * features, and the messaging profile the number was bought with or later
   * assigned to). Sync is keyed on `phoneNumber` in E.164 in both places, so
   * rows can be loaded into Convex from Twenty or pushed from Convex to
   * Twenty without losing the Telnyx metadata stored here.
   */
  phoneNumbers: defineTable({
    /** E.164, the sync key shared with Twenty `agencyPhones`. */
    phoneNumber: v.string(),
    /** Telnyx phone-number id, for `PATCH /phone_numbers/:id` assignment. */
    telnyxNumberId: v.optional(v.string()),
    /** Number-order id from `POST /number_orders`. */
    orderId: v.optional(v.string()),
    countryCode: v.optional(v.string()),
    locality: v.optional(v.string()),
    administrativeArea: v.optional(v.string()),
    rateCenter: v.optional(v.string()),
    numberType: v.optional(v.string()),
    features: v.optional(v.array(v.string())),
    reservable: v.optional(v.boolean()),
    quickship: v.optional(v.boolean()),
    upfrontCost: v.optional(v.string()),
    monthlyCost: v.optional(v.string()),
    currency: v.optional(v.string()),
    /** Messaging profile bound at purchase or via later assignment. */
    messagingProfileId: v.optional(v.string()),
    /** `pending` / `success` / `failure` from the number order. */
    status: v.optional(v.string()),
    purchasedAt: v.optional(v.number()),
  })
    .index("phoneNumber", ["phoneNumber"])
    .index("orderId", ["orderId"])
    .index("status", ["status"]),

  /**
   * A conversation, keyed on the pair of numbers that define it.
   *
   * `pairKey` is the identity: the two E.164 numbers sorted and joined, so an
   * inbound event (peer in `from`) and the outbound send that follows it
   * (peer in `to`) resolve to the same row. A Telnyx message id is deliberately
   * not the key: it identifies one message, and keying on it would give every
   * message its own conversation.
   *
   * The summary fields exist so the list view is one indexed query rather than
   * a scan over every message. They are denormalized on purpose and updated in
   * the same transaction that writes the message, so they cannot drift.
   */
  conversations: defineTable({
    /** `sortedPeer|blasterNumber`, both E.164. */
    pairKey: v.string(),
    /** The other party, in E.164. */
    phoneNumber: v.string(),
    /** The Blaster number that reached them, in E.164. */
    blasterNumber: v.string(),
    /** Timestamp of the newest stored message, for ordering the list. */
    latestMessageAt: v.optional(v.number()),
    latestDirection: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
    /** Short prefix of the newest message body, for the list view. */
    latestPreview: v.optional(v.string()),
    messageCount: v.optional(v.number()),
    /** Telnyx message id of the newest message, for jumping straight to it. */
    latestMessageId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("pairKey", ["pairKey"])
    .index("latestMessageAt", ["latestMessageAt"])
    .index("phoneNumber", ["phoneNumber"])
    // The inbox is organised by the number we sent from, not by the peer, so
    // this is the index the list view actually queries. Pair lookup uses
    // pairKey and the "with this contact" view uses phoneNumber.
    .index("blasterNumber", ["blasterNumber"]),

  /**
   * One stored message, inbound or outbound.
   *
   * `providerEventId` is the dedupe key and is unique: Telnyx retries a
   * webhook up to three times, and a retry is the same event rather than a new
   * message. Uniqueness is enforced by the index plus an insert-time check, so
   * a redelivery resolves to the existing row instead of a second copy.
   */
  messages: defineTable({
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("inbound"), v.literal("outbound")),
    body: v.string(),
    /** E.164 on both ends, whatever the provider reported. */
    from: v.string(),
    to: v.string(),
    /** `received` / `queued` / `sent` / `delivered` / `failed` / `undelivered`. */
    status: v.string(),
    telnyxMessageId: v.optional(v.string()),
    /** Telnyx webhook event id. Present on inbound; absent on a message Blaster sent. */
    providerEventId: v.optional(v.string()),
    sentAt: v.number(),
    media: v.optional(
      v.array(v.object({ url: v.string(), contentType: v.optional(v.string()), size: v.optional(v.number()) })),
    ),
  })
    .index("conversation", ["conversationId", "sentAt"])
    .index("providerEventId", ["providerEventId"])
    .index("telnyxMessageId", ["telnyxMessageId"]),
});

