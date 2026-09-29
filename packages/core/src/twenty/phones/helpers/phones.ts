/**
 * Twenty `agencyPhones`: the workspace mirror of owned Telnyx numbers.
 *
 * Twenty is the system of record operators look at, Convex `phoneNumbers` is
 * the purchase ledger, and Telnyx is the source of truth for what was actually
 * provisioned. Sync is keyed on the E.164 number in all three places:
 *
 *   - `toAgencyPhoneRecord` converts a purchased Telnyx number (plus the
 *     messaging profile it was bought with or assigned to) into the Twenty
 *     REST create/update body. Field reads go through `selectValue` because a
 *     Twenty SELECT arrives as a bare string or `{value,label}`.
 *   - `fromAgencyPhoneRecord` converts a Twenty row back into the same shape,
 *     so a sync can compare without caring which side a value came from.
 *   - `planPhoneSync` diffs the Convex ledger against the Twenty rows and
 *     reports which numbers need creating in Twenty and which Twenty rows are
 *     missing from Convex. Both directions are optional: an operator can load
 *     numbers into Convex, load them from Twenty, or run both, while the
 *     purchase itself always goes through the Telnyx number-order path.
 */

import { selectValue, type TwentyClient, type TwentyRecord } from "../../crm/helpers/client.ts";
import type { AvailablePhoneNumber, PurchasedPhoneNumber } from "../../../telnyx/numbers/helpers/numbers.ts";

export const AGENCY_PHONES_OBJECT = "agencyPhones";

export interface AgencyPhoneInput {
  phoneNumber: string;
  messagingProfileId?: string | null;
  countryCode?: string | null;
  numberType?: string | null;
  telnyxNumberId?: string | null;
  orderId?: string | null;
  status?: string | null;
}

export interface PhoneSyncPlan {
  /** Numbers in Convex missing from Twenty, ready for `create`. */
  toCreateInTwenty: AgencyPhoneInput[];
  /** Twenty rows with no Convex entry, ready for `storePhoneNumber`. */
  toStoreInConvex: AgencyPhoneInput[];
}

/** Build the Twenty REST body for a freshly purchased number. */
export function toAgencyPhoneRecord(
  purchased: PurchasedPhoneNumber,
  options: { messagingProfileId?: string | null; orderId?: string | null } = {},
): Record<string, unknown> {
  return {
    phoneNumber: purchased.phoneNumber,
    messagingProfileId: options.messagingProfileId ?? null,
    countryCode: purchased.countryCode,
    numberType: purchased.numberType,
    telnyxNumberId: purchased.id,
    orderId: options.orderId ?? null,
    status: purchased.status,
  };
}

/** Build the Twenty REST body for an available (not yet purchased) candidate. */
export function availableToAgencyPhoneRecord(
  candidate: AvailablePhoneNumber,
  messagingProfileId?: string | null,
): Record<string, unknown> {
  return {
    phoneNumber: candidate.phoneNumber,
    messagingProfileId: messagingProfileId ?? null,
    countryCode: candidate.countryCode,
    numberType: candidate.numberType,
    status: "available",
  };
}

/** Read a Twenty `agencyPhones` row back into the sync shape. */
export function fromAgencyPhoneRecord(record: TwentyRecord): AgencyPhoneInput {
  const get = (name: string): unknown => record[name];
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;
  return {
    phoneNumber:
      text(get("phoneNumber")) ?? text(get("phone_number")) ?? text(get("phone")) ?? "",
    messagingProfileId:
      text(get("messagingProfileId")) ?? text(get("messaging_profile_id")) ?? null,
    countryCode: selectValue(get("countryCode")) ?? text(get("country_code")) ?? null,
    numberType: selectValue(get("numberType")) ?? text(get("number_type")) ?? null,
    telnyxNumberId: text(get("telnyxNumberId")) ?? text(get("telnyx_number_id")) ?? null,
    orderId: text(get("orderId")) ?? text(get("order_id")) ?? null,
    status: selectValue(get("status")) ?? null,
  };
}

/** Diff Convex against Twenty by E.164, so either side can be the source. */
export function planPhoneSync(
  convexPhones: AgencyPhoneInput[],
  twentyPhones: AgencyPhoneInput[],
): PhoneSyncPlan {
  const twentyByNumber = new Map(
    twentyPhones.filter((row) => row.phoneNumber).map((row) => [row.phoneNumber, row]),
  );
  const convexByNumber = new Map(
    convexPhones.filter((row) => row.phoneNumber).map((row) => [row.phoneNumber, row]),
  );
  return {
    toCreateInTwenty: convexPhones.filter(
      (row) => row.phoneNumber && !twentyByNumber.has(row.phoneNumber),
    ),
    toStoreInConvex: twentyPhones.filter(
      (row) => row.phoneNumber && !convexByNumber.has(row.phoneNumber),
    ),
  };
}

/** List every `agencyPhones` row, tolerating a workspace without the object. */
export async function listAgencyPhones(client: TwentyClient): Promise<TwentyRecord[]> {
  try {
    return await client.listAll<TwentyRecord>(AGENCY_PHONES_OBJECT);
  } catch (error) {
    if (error instanceof Error && error.name === "TwentyError") {
      const status = (error as { status?: number }).status;
      if (status === 404) return [];
    }
    throw error;
  }
}

/**
 * Create the row, or patch the existing one matched by phone number.
 * Twenty has no upsert, so the match is an explicit filtered read first.
 */
export async function upsertAgencyPhone(
  client: TwentyClient,
  input: AgencyPhoneInput,
): Promise<TwentyRecord | null> {
  const existing = await client.listAll<TwentyRecord>(AGENCY_PHONES_OBJECT, {
    filter: `phoneNumber[eq]:"${input.phoneNumber}"`,
  });
  const match = existing.find((record) => {
    const parsed = fromAgencyPhoneRecord(record);
    return parsed.phoneNumber === input.phoneNumber;
  });
  const body: Record<string, unknown> = {
    phoneNumber: input.phoneNumber,
    messagingProfileId: input.messagingProfileId ?? null,
    countryCode: input.countryCode ?? null,
    numberType: input.numberType ?? null,
    telnyxNumberId: input.telnyxNumberId ?? null,
    orderId: input.orderId ?? null,
    status: input.status ?? null,
  };
  if (match) return client.update<TwentyRecord>(AGENCY_PHONES_OBJECT, match.id, body);
  return client.create<TwentyRecord>(AGENCY_PHONES_OBJECT, body);
}
