import { action } from "../_generated/server.js";
import { v } from "convex/values";
import { internal } from "../_generated/api.js";
import { TELNYX_BASE, telnyxKey } from "./model.js";

/**
 * Phone-number provider calls.
 *
 * External side effects only: every function here calls Telnyx and then stores
 * what it returned via an internal mutation. No database writes happen inline,
 * so a provider failure cannot leave a half-written row. See
 * docs/convex-naming-conventions.md (rule R5).
 */

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
      await ctx.runMutation(internal.phoneNumbers.mutations.storePhoneNumber, {
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
