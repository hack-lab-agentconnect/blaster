import { defineTable } from "convex/server";
import { v } from "convex/values";

/** Tables for owned Telnyx phone numbers. */
export const phoneTables = {
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
};
