import { action, internalMutation, mutation, query } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

/**
 * Owned Telnyx numbers: the purchase ledger and the canonical buy path.
 *
 * The mounted `telnyx` component owns inbound webhook signature verification;
 * this module owns the number lifecycle that the component does not persist:
 * searching inventory (`GET /available_phone_numbers`), purchasing exact
 * numbers (`POST /number_orders`), assigning a messaging profile
 * (`PATCH /phone_numbers/:id`), and storing the exact Telnyx metadata per
 * number in the `phoneNumbers` table.
 *
 * Sync with Twenty `agencyPhones` is optional in both directions and keyed on
 * the E.164 number:
 *   - `listPhoneNumbers` returns the ledger so the Hono API (or an agent) can
 *     push missing rows into Twenty.
 *   - `importTwentyPhones` accepts Twenty rows and stores the ones Convex has
 *     not seen, so numbers created elsewhere can be loaded into Convex.
 * The purchase itself always runs here through `purchaseNumbers`, never as a
 * direct Twenty write, so every surface (API, CLI, MCP, agent) shares one
 * buy path.
 */

const TELNYX_BASE = "https://api.telnyx.com/v2";

const phoneInput = v.object({
  phoneNumber: v.string(),
  telnyxNumberId: v.optional(v.string()),
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
  messagingProfileId: v.optional(v.string()),
  status: v.optional(v.string()),
  purchasedAt: v.optional(v.number()),
});

type PhoneInput = {
  phoneNumber: string;
  telnyxNumberId?: string;
  orderId?: string;
  countryCode?: string;
  locality?: string;
  administrativeArea?: string;
  rateCenter?: string;
  numberType?: string;
  features?: string[];
  reservable?: boolean;
  quickship?: boolean;
  upfrontCost?: string;
  monthlyCost?: string;
  currency?: string;
  messagingProfileId?: string;
  status?: string;
  purchasedAt?: number;
};

export const listPhoneNumbers = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("phoneNumbers").collect();
    return rows.sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));
  },
});

export const getPhoneNumber = query({
  args: { phoneNumber: v.string() },
  handler: async (ctx, args) => {
    return ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
  },
});

/** Insert or refresh one ledger row, keyed on the E.164 number. */
export const storePhoneNumber = internalMutation({
  args: { phone: phoneInput },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phone.phoneNumber))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args.phone });
      return existing._id;
    }
    return ctx.db.insert("phoneNumbers", { ...args.phone });
  },
});

/** Record a messaging-profile assignment made via `PATCH /phone_numbers/:id`. */
export const setMessagingBinding = mutation({
  args: { phoneNumber: v.string(), messagingProfileId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("phoneNumbers")
      .withIndex("phoneNumber", (q) => q.eq("phoneNumber", args.phoneNumber))
      .unique();
    if (!existing) throw new Error(`unknown phone number ${args.phoneNumber}`);
    await ctx.db.patch(existing._id, { messagingProfileId: args.messagingProfileId });
    return existing._id;
  },
});

/**
 * Load numbers from Twenty `agencyPhones` into Convex.
 * Accepts already-read Twenty rows so this mutation needs no Twenty key; the
 * API/CLI/MCP layer reads Twenty and passes the rows in.
 */
export const importTwentyPhones = mutation({
  args: { phones: v.array(phoneInput) },
  handler: async (ctx, args) => {
    let stored = 0;
    for (const phone of args.phones as PhoneInput[]) {
      if (!phone.phoneNumber) continue;
      const existing = await ctx.db
        .query("phoneNumbers")
        .withIndex("phoneNumber", (q) => q.eq("phoneNumber", phone.phoneNumber))
        .unique();
      if (existing) continue;
      await ctx.db.insert("phoneNumbers", { ...phone });
      stored += 1;
    }
    return { stored, skipped: args.phones.length - stored };
  },
});

function telnyxKey(): string {
  const key = process.env.TELNYX_API_KEY;
  if (!key) throw new Error("TELNYX_API_KEY is not configured on the Convex deployment");
  return key;
}

/** Search inventory: `GET /available_phone_numbers` with `filter[...]`. */
export const searchAvailable = action({
  args: {
    countryCode: v.optional(v.string()),
    numberType: v.optional(v.string()),
    features: v.optional(v.string()),
    limit: v.optional(v.number()),
    locality: v.optional(v.string()),
    administrativeArea: v.optional(v.string()),
    contains: v.optional(v.string()),
    startsWith: v.optional(v.string()),
    endsWith: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const params = new URLSearchParams();
    if (args.countryCode) params.set("filter[country_code]", args.countryCode);
    if (args.numberType) params.set("filter[phone_number_type]", args.numberType);
    if (args.features) params.set("filter[features]", args.features);
    if (args.limit !== undefined) params.set("filter[limit]", String(args.limit));
    if (args.locality) params.set("filter[locality]", args.locality);
    if (args.administrativeArea) params.set("filter[administrative_area]", args.administrativeArea);
    if (args.contains) params.set("filter[phone_number][contains]", args.contains);
    if (args.startsWith) params.set("filter[phone_number][starts_with]", args.startsWith);
    if (args.endsWith) params.set("filter[phone_number][ends_with]", args.endsWith);
    const query = params.toString();
    const response = await fetch(
      `${TELNYX_BASE}/available_phone_numbers${query ? `?${query}` : ""}`,
      { headers: { Authorization: `Bearer ${telnyxKey()}` } },
    );
    if (!response.ok) throw new Error(`Telnyx ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = (await response.json()) as { data?: unknown };
    return payload.data ?? [];
  },
});

/**
 * Purchase exact numbers: `POST /number_orders`, then store each number with
 * its order metadata. When `messagingProfileId` is given it is sent on the
 * order so the numbers arrive already bound; the binding is stored per row.
 */
export const purchaseNumbers = action({
  args: {
    phoneNumbers: v.array(v.string()),
    messagingProfileId: v.optional(v.string()),
    customerReference: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ orderId: string | null; stored: number }> => {
    if (args.phoneNumbers.length === 0) throw new Error("at least one phone number is required");
    const body: Record<string, unknown> = {
      phone_numbers: args.phoneNumbers.map((phone_number) => ({ phone_number })),
    };
    if (args.messagingProfileId) body.messaging_profile_id = args.messagingProfileId;
    if (args.customerReference) body.customer_reference = args.customerReference;
    const response = await fetch(`${TELNYX_BASE}/number_orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${telnyxKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Telnyx ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const payload = (await response.json()) as { data?: Record<string, unknown> };
    const data = payload.data ?? {};
    const orderId = typeof data.id === "string" ? data.id : null;
    const status = typeof data.status === "string" ? data.status : null;
    const numbers = (Array.isArray(data.phone_numbers) ? data.phone_numbers : []) as Array<
      Record<string, unknown>
    >;
    const purchasedAt = Date.now();
    let stored = 0;
    // Annotate as records up front: the Telnyx payload and the local
    // fallback have different shapes, and without this the fallback's narrow
    // `{ phone_number: string }` type hides the Telnyx fields below.
    const entries = (
      numbers.length > 0 ? numbers : args.phoneNumbers.map((n) => ({ phone_number: n }))
    ) as Array<Record<string, unknown>>;
    for (const entry of entries) {
      const phoneNumber = typeof entry.phone_number === "string" ? entry.phone_number : "";
      if (!phoneNumber) continue;
      await ctx.runMutation(internal.phoneNumbers.storePhoneNumber, {
        phone: {
          phoneNumber,
          telnyxNumberId: typeof entry.id === "string" ? entry.id : undefined,
          orderId: orderId ?? undefined,
          countryCode:
            typeof entry.country_code === "string"
              ? entry.country_code
              : typeof entry.country_iso_alpha2 === "string"
                ? (entry.country_iso_alpha2 as string)
                : undefined,
          numberType: typeof entry.phone_number_type === "string" ? (entry.phone_number_type as string) : undefined,
          messagingProfileId: args.messagingProfileId,
          status: typeof entry.status === "string" ? (entry.status as string) : (status ?? undefined),
          purchasedAt,
        },
      });
      stored += 1;
    }
    return { orderId, stored };
  },
});
