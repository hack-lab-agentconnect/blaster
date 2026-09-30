/**
 * Twenty `agencyProspects`: the pool a batch send draws from.
 *
 * Records always go through REST (`TwentyClient.listPage`), because the REST
 * routes are generated from the live schema and cover the custom `agency*`
 * objects; GraphQL stays the metadata path per `TwentyClient.graphql`. The
 * field menu below is grounded in the vendored generated schema
 * (`twenty/api/generated/schema.ts`, `AgencyProspectFilterInput`), which is
 * itself generated from this deployment's schema — the CLI never invents
 * field names or operators, it renders this menu.
 *
 * Two TwentyClient behaviors this module works around rather than with:
 * `listPage` replaces the caller filter with the keyset cursor instead of
 * combining them, so filtered walks combine explicitly via `combineFilters`;
 * and `listAll` does not combine either, so anything needing the whole
 * filtered set walks with `walkProspects`.
 */

import type {
  ProspectField,
  ProspectFilter,
  ProspectSummary,
} from "../../../blaster/api/types.ts";
import {
  combineFilters,
  type TwentyClient,
  type TwentyRecord,
} from "../../crm/helpers/client.ts";
import { fromAgencyPhoneRecord } from "../../phones/helpers/phones.ts";
export const AGENCY_PROSPECTS_OBJECT = "agencyProspects";

/** E.164, the only phone shape Telnyx accepts. */
export const E164 = /^\+[1-9]\d{6,14}$/;

type FieldType = ProspectField["type"];

interface MenuEntry {
  name: string;
  label: string;
  type: FieldType;
  filterOperators: string[];
  /** Allowed values for enum fields; other types ignore it. */
  values?: string[];
}

/**
 * The filterable menu, one entry per `AgencyProspectFilterInput` member worth
 * exposing. Operator lists are the REST-valid subset of each GraphQL filter
 * kind (string: eq/neq/like/ilike; number: eq/gt/gte/lt/lte; boolean/enum:
 * eq). Anything not on this menu is a 400.
 */
const MENU: MenuEntry[] = [
  { name: "name", label: "Business name", type: "string", filterOperators: ["eq", "neq", "like", "ilike"] },
  { name: "phone", label: "Primary phone", type: "string", filterOperators: ["eq", "like"] },
  { name: "niche", label: "Industry", type: "string", filterOperators: ["eq", "neq", "like", "ilike"] },
  { name: "city", label: "City", type: "string", filterOperators: ["eq", "neq", "like", "ilike"] },
  { name: "region", label: "State or region", type: "string", filterOperators: ["eq", "neq", "like", "ilike"] },
  { name: "country", label: "Country", type: "string", filterOperators: ["eq", "neq", "like", "ilike"] },
  { name: "website", label: "Website", type: "string", filterOperators: ["like", "ilike"] },
  { name: "rating", label: "Average rating", type: "number", filterOperators: ["eq", "gt", "gte", "lt", "lte"] },
  { name: "reviewCount", label: "Review count", type: "number", filterOperators: ["eq", "gt", "gte", "lt", "lte"] },
  { name: "aiFitScore", label: "AI fit score", type: "number", filterOperators: ["eq", "gt", "gte", "lt", "lte"] },
  {
    name: "whatsappStatus",
    label: "WhatsApp status",
    type: "enum",
    filterOperators: ["eq"],
    values: ["PENDING", "VALIDATED", "REJECTED"],
  },
  { name: "whatsappValidated", label: "WhatsApp validated", type: "boolean", filterOperators: ["eq"] },
  { name: "phoneValid", label: "Phone valid", type: "boolean", filterOperators: ["eq"] },
  {
    name: "outboundState",
    label: "Outbound stage",
    type: "enum",
    filterOperators: ["eq"],
    values: [
      "NEW",
      "ENRICHED",
      "VIDEO_READY",
      "QUEUED",
      "SENDING",
      "AWAITING_DELIVERY",
      "AWAITING_REPLY",
      "REPLIED",
      "QUALIFIED",
      "BOOKED",
      "COMPLETED",
      "PAUSED",
      "OPTED_OUT",
      "FAILED",
    ],
  },
  { name: "campaignIdId", label: "Campaign ID (UUID)", type: "string", filterOperators: ["eq"] },
];

export function prospectFields(): ProspectField[] {
  return MENU.map(({ name, label, type, filterOperators }) => ({ name, label, type, filterOperators }));
}

export interface ValidatedFilter {
  field: MenuEntry;
  operator: string;
  /** Coerced to the field type; strings stay strings. */
  value: string | number | boolean;
}

function coerceValue(entry: MenuEntry, raw: unknown): { value?: string | number | boolean; problem?: string } {
  if (entry.type === "boolean") {
    if (typeof raw === "boolean") return { value: raw };
    if (typeof raw === "string") {
      const lowered = raw.trim().toLowerCase();
      if (lowered === "true") return { value: true };
      if (lowered === "false") return { value: false };
    }
    return { problem: `value for ${entry.name} must be true or false` };
  }
  if (entry.type === "number") {
    const numeric = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
    if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
      return { problem: `value for ${entry.name} must be a number` };
    }
    return { value: numeric };
  }
  if (entry.type === "enum") {
    if (typeof raw !== "string" || raw.trim() === "") return { problem: `value for ${entry.name} is required` };
    const value = raw.trim();
    if (entry.values && !entry.values.includes(value)) {
      return { problem: `value for ${entry.name} must be one of ${entry.values.join(", ")}` };
    }
    return { value };
  }
  if (typeof raw !== "string" || raw === "") return { problem: `value for ${entry.name} is required` };
  return { value: raw };
}

/**
 * Validate raw clauses against the menu. Unknown fields, unsupported
 * operators, and uncoercible values come back as problems rather than
 * throwing, so the route can report every problem at once.
 */
export function validateProspectFilters(filters: unknown): { filters: ValidatedFilter[] } | { problems: string[] } {
  if (!Array.isArray(filters)) return { problems: ["filters must be an array"] };
  const problems: string[] = [];
  const valid: ValidatedFilter[] = [];
  for (const [index, clause] of filters.entries()) {
    const prefix = `filters[${index}]`;
    const candidate = (clause ?? {}) as Partial<ProspectFilter>;
    const entry = MENU.find((item) => item.name === candidate.field);
    if (!entry) {
      problems.push(`${prefix}.field is not filterable`);
      continue;
    }
    if (typeof candidate.operator !== "string" || !entry.filterOperators.includes(candidate.operator)) {
      problems.push(`${prefix}.operator must be one of ${entry.filterOperators.join(", ")}`);
      continue;
    }
    const coerced = coerceValue(entry, candidate.value);
    if (coerced.problem || coerced.value === undefined) {
      problems.push(`${prefix}.${coerced.problem ?? "value is invalid"}`);
      continue;
    }
    valid.push({ field: entry, operator: candidate.operator, value: coerced.value });
  }
  if (problems.length > 0) return { problems };
  return { filters: valid };
}

function escapeDslString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Render one validated clause in the REST filter DSL. */
export function filterToDsl(filter: ValidatedFilter): string {
  const rendered = typeof filter.value === "string" ? escapeDslString(filter.value) : String(filter.value);
  return `${filter.field.name}[${filter.operator}]:${rendered}`;
}

export function filtersToDsl(filters: ValidatedFilter[]): string | undefined {
  if (filters.length === 0) return undefined;
  return filters.map(filterToDsl).join(" AND ");
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map a Twenty row to the contract summary. Relation shapes are read defensively. */
export function summarizeProspect(record: TwentyRecord): ProspectSummary {
  const campaign = record["campaignId"];
  return {
    id: record.id,
    name: textOf(record["name"]) ?? "",
    phone: textOf(record["phone"]),
    country: textOf(record["country"]),
    campaign:
      campaign !== null &&
      typeof campaign === "object" &&
      typeof (campaign as { name?: unknown }).name === "string"
        ? ((campaign as { name: string }).name ?? null)
        : null,
  };
}

export interface ProspectPage {
  summaries: ProspectSummary[];
  nextCursor: string | null;
  total: number;
}

/** One page, with the caller filter combined with the keyset cursor. */
export async function searchProspectsPage(
  client: TwentyClient,
  input: { dsl?: string; cursor?: string | null; limit?: number },
): Promise<ProspectPage> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
  const page = await client.listPage<TwentyRecord>(AGENCY_PROSPECTS_OBJECT, {
    filter: combineFilters(input.dsl, input.cursor ?? undefined),
    limit,
  });
  return {
    summaries: page.records.map(summarizeProspect),
    nextCursor: page.hasNextPage ? page.endCursor : null,
    total: page.totalCount,
  };
}

/** Walk every matching page as raw rows. Bounded like `listAll` so a runaway cannot spin forever. */
export async function walkProspectRows(client: TwentyClient, dsl?: string, maxPages = 50): Promise<TwentyRecord[]> {
  const rows: TwentyRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await client.listPage<TwentyRecord>(AGENCY_PROSPECTS_OBJECT, {
      filter: combineFilters(dsl, cursor),
      limit: 200,
    });
    rows.push(...result.records);
    if (!result.hasNextPage || !result.endCursor) break;
    cursor = result.endCursor;
  }
  return rows;
}

/** Outbound stages a batch never sends into, with the reason the operator sees. */
const SKIP_OUTBOUND_STATE: Record<string, string> = {
  OPTED_OUT: "opted out",
  PAUSED: "sending paused",
  REPLIED: "already replied",
  QUALIFIED: "already qualified",
  BOOKED: "already booked",
  COMPLETED: "already completed",
};

export interface EligibilitySplit {
  eligible: ProspectSummary[];
  skipped: Array<{ summary: ProspectSummary; reason: string }>;
}

/**
 * Read one prospect's outbound stage for skip decisions. Twenty rows are read
 * defensively: an unknown shape is "no stage", never a crash.
 */
export function outboundStageOf(record: TwentyRecord): string | null {
  return textOf(record["outboundState"]);
}

/**
 * Split walked rows into sendable and skipped, with a reason per skip. A row
 * without a sendable E.164 phone or sitting in a terminal lifecycle stage
 * never reaches Telnyx.
 */
export function splitEligibility(rows: TwentyRecord[]): EligibilitySplit {
  const eligible: ProspectSummary[] = [];
  const skipped: Array<{ summary: ProspectSummary; reason: string }> = [];
  for (const record of rows) {
    const summary = summarizeProspect(record);
    if (!summary.phone || !E164.test(summary.phone)) {
      skipped.push({ summary, reason: "no sendable phone number" });
      continue;
    }
    const skipReason = SKIP_OUTBOUND_STATE[outboundStageOf(record) ?? ""];
    if (skipReason) {
      skipped.push({ summary, reason: skipReason });
      continue;
    }
    eligible.push(summary);
  }
  return { eligible, skipped };
}

/** Advance one prospect's outbound lifecycle. Throws TwentyError on failure. */
export async function markProspectOutbound(client: TwentyClient, id: string, state: string): Promise<void> {
  await client.update(AGENCY_PROSPECTS_OBJECT, id, { outboundState: state });
}

/** Find one sending-number row by record id. Pure: the caller lists the rows,
 *  so the Twenty call stays mockable at the route boundary while this
 *  matching stays real. */
export function findAgencyPhoneRow(
  rows: TwentyRecord[],
  agencyPhoneId: string,
): { record: TwentyRecord; phoneNumber: string; messagingProfileId: string | null } | null {
  const record = rows.find((row) => row.id === agencyPhoneId);
  if (!record) return null;
  const parsed = fromAgencyPhoneRecord(record);
  if (!parsed.phoneNumber) return null;
  return { record, phoneNumber: parsed.phoneNumber, messagingProfileId: parsed.messagingProfileId ?? null };
}
