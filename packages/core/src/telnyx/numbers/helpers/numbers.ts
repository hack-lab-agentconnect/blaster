/**
 * Telnyx phone-number inventory: search, purchase, and messaging assignment.
 *
 * Endpoints (Telnyx API v2, base `https://api.telnyx.com/v2`):
 *   - `GET /available_phone_numbers` with `filter[...]` query params searches
 *     inventory by country, locality, number type, features, and pattern.
 *   - `POST /number_orders` with `{ phone_numbers: [{ phone_number }],
 *     messaging_profile_id?, customer_reference? }` purchases exact numbers.
 *   - `GET /number_orders/:id` tracks fulfillment (`pending`/`success`/`failure`).
 *   - `PATCH /phone_numbers/:id` with `{ messaging_profile_id }` assigns a
 *     purchased number to a messaging profile so it can send/receive SMS.
 *   - `GET /phone_numbers/messaging` (via `phoneNumbers.messaging.list`)
 *     lists messaging-capable numbers on the account.
 *
 * Two transports hit the same endpoints:
 *   - REST fetch (`searchAvailableNumbersRest`, `createNumberOrderRest`, ...),
 *     which runs anywhere fetch runs, including Convex actions.
 *   - The official `telnyx` npm SDK (`searchAvailableNumbers`,
 *     `createNumberOrder`, ...), which is the preferred Node transport for the
 *     CLI, MCP server, and Hono API. SDK calls use the real client types
 *     (`InstanceType<typeof Telnyx>`), so a wrong method or field fails the
 *     typecheck instead of failing at runtime: `client.availablePhoneNumbers.list`,
 *     `client.numberOrders.create/retrieve`,
 *     `client.phoneNumbers.messaging.update/list`, `client.messages.send`.
 *
 * The purchase always flows through these helpers, whether the caller is the
 * Convex `phoneNumbers` action, the Hono API, the CLI, or the MCP server, so
 * an agent gets the same search/buy semantics on every surface.
 */

import { TelnyxError, officialClient, toTelnyxError } from "../../messaging/helpers/client.ts";

const TELNYX_BASE = "https://api.telnyx.com/v2";

export type NumberType = "local" | "toll_free" | "mobile" | "national" | "shared_cost";

export type NumberFeature =
  | "sms"
  | "mms"
  | "voice"
  | "fax"
  | "emergency"
  | "hd_voice"
  | "international_sms"
  | "local_calling";

export interface AvailableNumberFilters {
  countryCode?: string;
  numberType?: NumberType;
  features?: NumberFeature[];
  limit?: number;
  locality?: string;
  administrativeArea?: string;
  rateCenter?: string;
  nationalDestinationCode?: string;
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  reservable?: boolean;
  quickship?: boolean;
  bestEffort?: boolean;
  excludeHeldNumbers?: boolean;
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  countryCode: string | null;
  locality: string | null;
  administrativeArea: string | null;
  rateCenter: string | null;
  numberType: NumberType | null;
  features: string[];
  reservable: boolean | null;
  quickship: boolean | null;
  bestEffort: boolean | null;
  upfrontCost: string | null;
  monthlyCost: string | null;
  currency: string | null;
}

export interface PurchaseInput {
  phoneNumbers: string[];
  messagingProfileId?: string;
  customerReference?: string;
  connectionId?: string;
  billingGroupId?: string;
}

export interface PurchasedPhoneNumber {
  id: string | null;
  phoneNumber: string;
  countryCode: string | null;
  numberType: NumberType | null;
  status: string | null;
  requirementsMet: boolean | null;
}

export interface NumberOrder {
  id: string | null;
  status: string | null;
  customerReference: string | null;
  messagingProfileId: string | null;
  requirementsMet: boolean | null;
  phoneNumbers: PurchasedPhoneNumber[];
}

/** Encode search filters as `filter[...]` query params for the REST transport. */
export function buildAvailableNumbersQuery(filters: AvailableNumberFilters = {}): string {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") params.set(`filter[${key}]`, value);
  };
  set("country_code", filters.countryCode);
  set("phone_number_type", filters.numberType);
  set("locality", filters.locality);
  set("administrative_area", filters.administrativeArea);
  set("rate_center", filters.rateCenter);
  set("national_destination_code", filters.nationalDestinationCode);
  if (filters.features?.length) params.set("filter[features]", filters.features.join(","));
  if (filters.limit !== undefined) params.set("filter[limit]", String(filters.limit));
  if (filters.reservable !== undefined) params.set("filter[reservable]", String(filters.reservable));
  if (filters.quickship !== undefined) params.set("filter[quickship]", String(filters.quickship));
  if (filters.bestEffort !== undefined) params.set("filter[best_effort]", String(filters.bestEffort));
  if (filters.excludeHeldNumbers !== undefined) {
    params.set("filter[exclude_held_numbers]", String(filters.excludeHeldNumbers));
  }
  if (filters.contains) params.set("filter[phone_number][contains]", filters.contains);
  if (filters.startsWith) params.set("filter[phone_number][starts_with]", filters.startsWith);
  if (filters.endsWith) params.set("filter[phone_number][ends_with]", filters.endsWith);
  return params.toString();
}

function regionValue(
  regions: Array<Record<string, unknown>> | undefined,
  type: string,
): string | null {
  const match = regions?.find((region) => region.region_type === type);
  const name = match?.region_name;
  return typeof name === "string" ? name : null;
}

/** Normalise one `available_phone_number` record, tolerating missing fields. */
export function parseAvailableNumber(raw: Record<string, unknown>): AvailablePhoneNumber {
  const regions = Array.isArray(raw.region_information)
    ? (raw.region_information as Array<Record<string, unknown>>)
    : undefined;
  const cost = (raw.cost_information ?? {}) as Record<string, unknown>;
  const phoneNumber = typeof raw.phone_number === "string" ? raw.phone_number : "";
  return {
    phoneNumber,
    countryCode: regionValue(regions, "country_code") ?? regionValue(regions, "country"),
    locality: regionValue(regions, "locality"),
    administrativeArea: regionValue(regions, "administrative_area"),
    rateCenter: regionValue(regions, "rate_center"),
    numberType: isNumberType(raw.phone_number_type) ? raw.phone_number_type : null,
    features: Array.isArray(raw.features) ? (raw.features as unknown[]).map(String) : [],
    reservable: typeof raw.reservable === "boolean" ? raw.reservable : null,
    quickship: typeof raw.quickship === "boolean" ? raw.quickship : null,
    bestEffort: typeof raw.best_effort === "boolean" ? raw.best_effort : null,
    upfrontCost: typeof cost.upfront_cost === "string" ? cost.upfront_cost : null,
    monthlyCost: typeof cost.monthly_cost === "string" ? cost.monthly_cost : null,
    currency: typeof cost.currency === "string" ? cost.currency : null,
  };
}

function isNumberType(value: unknown): value is NumberType {
  return (
    value === "local" ||
    value === "toll_free" ||
    value === "mobile" ||
    value === "national" ||
    value === "shared_cost"
  );
}

/** Normalise a `number_orders` response into the stored shape. */
export function parseNumberOrder(raw: Record<string, unknown>): NumberOrder {
  const numbers = Array.isArray(raw.phone_numbers) ? raw.phone_numbers : [];
  return {
    id: typeof raw.id === "string" ? raw.id : null,
    status: typeof raw.status === "string" ? raw.status : null,
    customerReference: typeof raw.customer_reference === "string" ? raw.customer_reference : null,
    messagingProfileId:
      typeof raw.messaging_profile_id === "string" ? raw.messaging_profile_id : null,
    requirementsMet: typeof raw.requirements_met === "boolean" ? raw.requirements_met : null,
    phoneNumbers: (numbers as Array<Record<string, unknown>>).map((entry) => ({
      id: typeof entry.id === "string" ? entry.id : null,
      phoneNumber: typeof entry.phone_number === "string" ? entry.phone_number : "",
      countryCode:
        typeof entry.country_code === "string"
          ? entry.country_code
          : typeof entry.country_iso_alpha2 === "string"
            ? entry.country_iso_alpha2
            : null,
      numberType: isNumberType(entry.phone_number_type) ? entry.phone_number_type : null,
      status: typeof entry.status === "string" ? entry.status : null,
      requirementsMet: typeof entry.requirements_met === "boolean" ? entry.requirements_met : null,
    })),
  };
}

async function throwForResponse(response: Response): Promise<never> {
  const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
  throw new TelnyxError(response.status, detail);
}

/** REST search: `GET /available_phone_numbers`. Runs in Node and Convex. */
export async function searchAvailableNumbersRest(
  apiKey: string,
  filters: AvailableNumberFilters = {},
  fetchImpl: typeof fetch = fetch,
): Promise<AvailablePhoneNumber[]> {
  const query = buildAvailableNumbersQuery(filters);
  const response = await fetchImpl(`${TELNYX_BASE}/available_phone_numbers${query ? `?${query}` : ""}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await throwForResponse(response);
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map(parseAvailableNumber);
}

/** REST purchase: `POST /number_orders` for exact phone numbers. */
export async function createNumberOrderRest(
  apiKey: string,
  input: PurchaseInput,
  fetchImpl: typeof fetch = fetch,
): Promise<NumberOrder> {
  if (input.phoneNumbers.length === 0) throw new TelnyxError(400, "at least one phone_number is required");
  const body: Record<string, unknown> = {
    phone_numbers: input.phoneNumbers.map((phone_number) => ({ phone_number })),
  };
  if (input.messagingProfileId) body.messaging_profile_id = input.messagingProfileId;
  if (input.customerReference) body.customer_reference = input.customerReference;
  if (input.connectionId) body.connection_id = input.connectionId;
  if (input.billingGroupId) body.billing_group_id = input.billingGroupId;
  const response = await fetchImpl(`${TELNYX_BASE}/number_orders`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwForResponse(response);
  const payload = (await response.json()) as { data?: Record<string, unknown> };
  return parseNumberOrder(payload.data ?? {});
}

/** REST order status: `GET /number_orders/:id`. */
export async function retrieveNumberOrderRest(
  apiKey: string,
  orderId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<NumberOrder> {
  const response = await fetchImpl(`${TELNYX_BASE}/number_orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await throwForResponse(response);
  const payload = (await response.json()) as { data?: Record<string, unknown> };
  return parseNumberOrder(payload.data ?? {});
}

/** REST assignment: `PATCH /phone_numbers/:id` binds a messaging profile. */
export async function assignMessagingProfileRest(
  apiKey: string,
  phoneNumberId: string,
  messagingProfileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${TELNYX_BASE}/phone_numbers/${encodeURIComponent(phoneNumberId)}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_profile_id: messagingProfileId }),
    },
  );
  if (!response.ok) await throwForResponse(response);
}

export interface OwnedPhoneNumber {
  id: string;
  phoneNumber: string;
  messagingProfileId: string | null;
  status: string | null;
}

/** REST list of owned numbers with messaging state, for the sync views. */
export async function listOwnedNumbersRest(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OwnedPhoneNumber[]> {
  const response = await fetchImpl(`${TELNYX_BASE}/phone_numbers?page[size]=100`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) await throwForResponse(response);
  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  return (payload.data ?? []).map((entry) => ({
    id: String(entry.id ?? ""),
    phoneNumber: typeof entry.phone_number === "string" ? entry.phone_number : "",
    messagingProfileId:
      typeof entry.messaging_profile_id === "string" ? entry.messaging_profile_id : null,
    status: typeof entry.status === "string" ? entry.status : null,
  }));
}

// ---------------------------------------------------------------------------
// Official SDK transport (Node surfaces: CLI, MCP, Hono API).
//
// The REST `*Rest` functions above stay: they run anywhere fetch runs,
// including Convex actions, whose isolate cannot take the Node SDK as a
// dependency. Everything on Node goes through the SDK below.
// ---------------------------------------------------------------------------

function sdkFilter(filters: AvailableNumberFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (filters.countryCode) filter.country_code = filters.countryCode;
  if (filters.numberType) filter.phone_number_type = filters.numberType;
  if (filters.features?.length) filter.features = filters.features;
  if (filters.limit !== undefined) filter.limit = filters.limit;
  if (filters.locality) filter.locality = filters.locality;
  if (filters.administrativeArea) filter.administrative_area = filters.administrativeArea;
  if (filters.rateCenter) filter.rate_center = filters.rateCenter;
  if (filters.nationalDestinationCode) {
    filter.national_destination_code = filters.nationalDestinationCode;
  }
  if (filters.reservable !== undefined) filter.reservable = filters.reservable;
  if (filters.quickship !== undefined) filter.quickship = filters.quickship;
  if (filters.bestEffort !== undefined) filter.best_effort = filters.bestEffort;
  if (filters.excludeHeldNumbers !== undefined) {
    filter.exclude_held_numbers = filters.excludeHeldNumbers;
  }
  const pattern: Record<string, string> = {};
  if (filters.contains) pattern.contains = filters.contains;
  if (filters.startsWith) pattern.starts_with = filters.startsWith;
  if (filters.endsWith) pattern.ends_with = filters.endsWith;
  if (Object.keys(pattern).length > 0) filter.phone_number = pattern;
  return { filter };
}

/** SDK search: `client.availablePhoneNumbers.list({ filter })`. */
export async function searchAvailableNumbers(
  apiKey: string,
  filters: AvailableNumberFilters = {},
): Promise<AvailablePhoneNumber[]> {
  try {
    const client = officialClient(apiKey);
    const response = await client.availablePhoneNumbers.list(sdkFilter(filters));
    const data = (response.data ?? []) as Array<Record<string, unknown>>;
    return data.map(parseAvailableNumber);
  } catch (error) {
    throw toTelnyxError(error);
  }
}

/** SDK purchase: `client.numberOrders.create({ phone_numbers, ... })`. */
export async function createNumberOrder(
  apiKey: string,
  input: PurchaseInput,
): Promise<NumberOrder> {
  if (input.phoneNumbers.length === 0) throw new TelnyxError(400, "at least one phone_number is required");
  try {
    const client = officialClient(apiKey);
    const response = await client.numberOrders.create({
      phone_numbers: input.phoneNumbers.map((phone_number) => ({ phone_number })),
      ...(input.messagingProfileId ? { messaging_profile_id: input.messagingProfileId } : {}),
      ...(input.customerReference ? { customer_reference: input.customerReference } : {}),
      ...(input.connectionId ? { connection_id: input.connectionId } : {}),
      ...(input.billingGroupId ? { billing_group_id: input.billingGroupId } : {}),
    });
    return parseNumberOrder((response.data ?? {}) as Record<string, unknown>);
  } catch (error) {
    throw toTelnyxError(error);
  }
}

/** SDK order status: `client.numberOrders.retrieve(id)`. */
export async function retrieveNumberOrder(apiKey: string, orderId: string): Promise<NumberOrder> {
  try {
    const client = officialClient(apiKey);
    const response = await client.numberOrders.retrieve(orderId);
    return parseNumberOrder((response.data ?? {}) as Record<string, unknown>);
  } catch (error) {
    throw toTelnyxError(error);
  }
}

/** SDK assignment: `client.phoneNumbers.messaging.update(id, { messaging_profile_id })`. */
export async function assignMessagingProfile(
  apiKey: string,
  phoneNumberId: string,
  messagingProfileId: string,
): Promise<void> {
  try {
    const client = officialClient(apiKey);
    await client.phoneNumbers.messaging.update(phoneNumberId, {
      messaging_profile_id: messagingProfileId,
    });
  } catch (error) {
    throw toTelnyxError(error);
  }
}

/** SDK owned numbers: `client.phoneNumbers.messaging.list`, first page of 100. */
export async function listOwnedNumbers(apiKey: string): Promise<OwnedPhoneNumber[]> {
  try {
    const client = officialClient(apiKey);
    const response = await client.phoneNumbers.messaging.list({ "page[size]": 100 });
    const data = (response.data ?? []) as Array<Record<string, unknown>>;
    return data.map((entry) => ({
      id: String(entry.id ?? ""),
      phoneNumber: typeof entry.phone_number === "string" ? entry.phone_number : "",
      messagingProfileId:
        typeof entry.messaging_profile_id === "string" ? entry.messaging_profile_id : null,
      status: typeof entry.status === "string" ? entry.status : null,
    }));
  } catch (error) {
    throw toTelnyxError(error);
  }
}
