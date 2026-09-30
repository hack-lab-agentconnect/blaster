/**
 * Prospect search over Twenty `agencyProspects`.
 *
 * The filter menu is grounded in the vendored generated schema
 * (`AgencyProspectFilterInput`): names are field API names and operators are
 * the REST-valid subset of each filter kind. Validation rejects everything
 * else, so a surface can never submit arbitrary Twenty query DSL; the DSL
 * rendering escapes values rather than interpolating them.
 */

import { describe, expect, test } from "vitest";
import {
  E164,
  OPERATORS,
  filterToDsl,
  filtersToDsl,
  findAgencyPhoneRow,
  markProspectOutbound,
  outboundStageOf,
  prospectFields,
  searchProspectsPage,
  splitEligibility,
  summarizeProspect,
  validateProspectFilters,
  walkProspectRows,
} from "../src/twenty/prospects/index.ts";
import type { TwentyClient, TwentyRecord } from "../src/twenty/crm/helpers/client.ts";

const record = (overrides: Record<string, unknown> = {}): TwentyRecord => ({
  id: "rec-1",
  name: "Acme Plumbing",
  phone: "+15551234567",
  country: "US",
  ...overrides,
});

describe("prospectFields", () => {
  test("every entry names real filterable members with a non-empty operator menu", () => {
    const fields = prospectFields();
    expect(fields.length).toBeGreaterThan(5);
    for (const field of fields) {
      expect(field.name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.filterOperators.length).toBeGreaterThan(0);
    }
    const names = fields.map((field) => field.name);
    for (const expected of ["name", "phone", "niche", "city", "country", "rating", "whatsappStatus"]) {
      expect(names).toContain(expected);
    }
  });

  test("operator labels line up with the tokens, and the registry is the source", () => {
    const fields = prospectFields();
    for (const field of fields) {
      expect(field.operatorLabels).toHaveLength(field.filterOperators.length);
      // Every label is a real human word from the shared OPERATORS registry.
      for (let i = 0; i < field.filterOperators.length; i += 1) {
        const op = OPERATORS.find((entry) => entry.token === field.filterOperators[i]);
        expect(op, `operator ${field.filterOperators[i]}`).toBeDefined();
        expect(field.operatorLabels[i]).toBe(op?.label);
      }
    }
  });
});

describe("validateProspectFilters", () => {
  test("accepts well-formed clauses", () => {
    const result = validateProspectFilters([
      { field: "niche", operator: "eq", value: "plumbing" },
      { field: "rating", operator: "gte", value: "4" },
      { field: "whatsappValidated", operator: "eq", value: "true" },
    ]);
    expect("problems" in result).toBe(false);
    if ("problems" in result) return;
    expect(result.filters).toHaveLength(3);
    expect(result.filters[1]?.value).toBe(4);
    expect(result.filters[2]?.value).toBe(true);
  });

  test("rejects a non-array, an unknown field, a wrong operator, and bad values", () => {
    expect(validateProspectFilters(null)).toEqual({ problems: ["filters must be an array"] });
    expect(validateProspectFilters([{ field: "nope", operator: "eq", value: "x" }])).toEqual({
      problems: ["filters[0].field is not filterable"],
    });
    expect(validateProspectFilters([{ field: "rating", operator: "like", value: "4" }])).toEqual({
      problems: ["filters[0].operator must be one of equals (eq), is not (neq), greater than (gt), at least (gte), less than (lt), at most (lte)"],
    });
    const badNumber = validateProspectFilters([{ field: "rating", operator: "gte", value: "high" }]);
    expect("problems" in badNumber && badNumber.problems).toEqual(["filters[0].value for rating must be a number"]);
    const badEnum = validateProspectFilters([{ field: "whatsappStatus", operator: "eq", value: "MAYBE" }]);
    expect("problems" in badEnum && badEnum.problems).toEqual([
      "filters[0].value for whatsappStatus must be one of PENDING, VALIDATED, REJECTED",
    ]);
    const badBool = validateProspectFilters([{ field: "whatsappValidated", operator: "eq", value: "yes" }]);
    expect("problems" in badBool && badBool.problems).toEqual([
      "filters[0].value for whatsappValidated must be true or false",
    ]);
  });
});

describe("filter DSL", () => {
  test("renders quoted strings, raw numbers and booleans", () => {
    const result = validateProspectFilters([
      { field: "niche", operator: "ilike", value: "plumb" },
      { field: "rating", operator: "gte", value: "4" },
      { field: "whatsappValidated", operator: "eq", value: "false" },
    ]);
    if ("problems" in result) throw new Error("setup failed");
    expect(result.filters.map(filterToDsl)).toEqual([
      'niche[ilike]:"plumb"',
      "rating[gte]:4",
      "whatsappValidated[eq]:false",
    ]);
    expect(filtersToDsl([])).toBeUndefined();
  });

  test("escapes quotes and backslashes rather than interpolating them", () => {
    const result = validateProspectFilters([{ field: "name", operator: "eq", value: 'a"b\\c' }]);
    if ("problems" in result) throw new Error("setup failed");
    const [only] = result.filters;
    if (!only) throw new Error("setup failed");
    expect(filterToDsl(only)).toBe('name[eq]:"a\\"b\\\\c"');
  });
});

describe("summarizeProspect", () => {
  test("maps the display fields and tolerates missing ones", () => {
    expect(summarizeProspect(record())).toEqual({
      id: "rec-1",
      name: "Acme Plumbing",
      phone: "+15551234567",
      country: "US",
      campaign: null,
    });
    expect(summarizeProspect(record({ name: "", phone: "", campaignId: { id: "c-1", name: "Spring" } }))).toEqual({
      id: "rec-1",
      name: "",
      phone: null,
      country: "US",
      campaign: "Spring",
    });
  });

  test("outboundStageOf reads the lifecycle defensively", () => {
    expect(outboundStageOf(record({ outboundState: "QUEUED" }))).toBe("QUEUED");
    expect(outboundStageOf(record({}))).toBeNull();
  });
});

describe("splitEligibility", () => {
  test("sends only E.164 numbers outside terminal lifecycle stages", () => {
    const { eligible, skipped } = splitEligibility([
      record({ id: "ok" }),
      record({ id: "no-phone", phone: "" }),
      record({ id: "bad-phone", phone: "555-1234" }),
      record({ id: "opted-out", outboundState: "OPTED_OUT" }),
      record({ id: "converted", outboundState: "BOOKED" }),
      record({ id: "queued", outboundState: "QUEUED" }),
    ]);
    expect(eligible.map((row) => row.id).sort()).toEqual(["ok", "queued"]);
    expect(skipped.map((row) => `${row.summary.id}:${row.reason}`).sort()).toEqual([
      "bad-phone:no sendable phone number",
      "converted:already booked",
      "no-phone:no sendable phone number",
      "opted-out:opted out",
    ]);
  });

  test("E164 matches the CLI's recipient shape", () => {
    expect(E164.test("+15551234567")).toBe(true);
    expect(E164.test("555-1234")).toBe(false);
  });
});

function fakeClient(pages: TwentyRecord[][]): TwentyClient {
  let calls = 0;
  return {
    listPage: async () => {
      const records = pages[Math.min(calls, pages.length - 1)] ?? [];
      calls += 1;
      return {
        records,
        hasNextPage: calls < pages.length,
        endCursor: records.length > 0 ? records[records.length - 1]?.id ?? null : null,
        totalCount: pages.reduce((total, page) => total + page.length, 0),
      };
    },
  } as unknown as TwentyClient;
}

describe("searchProspectsPage", () => {
  test("combines the caller filter with the keyset cursor", async () => {
    const seen: Array<string | undefined> = [];
    const client = {
      listPage: async (_path: string, options: { filter?: string }) => {
        seen.push(options.filter);
        return { records: [], hasNextPage: false, endCursor: null, totalCount: 0 };
      },
    } as unknown as TwentyClient;
    await searchProspectsPage(client, { dsl: 'niche[eq]:"plumbing"', cursor: "cursor-9", limit: 20 });
    expect(seen).toEqual(['(niche[eq]:"plumbing") AND id[gt]:"cursor-9"']);
    await searchProspectsPage(client, {});
    expect(seen[1]).toBeUndefined();
  });
});

describe("walkProspectRows", () => {
  test("walks every page until the cursor runs out", async () => {
    const rows = await walkProspectRows(
      fakeClient([[record({ id: "a" }), record({ id: "b" })], [record({ id: "c" })]]),
      'niche[eq]:"plumbing"',
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

describe("findAgencyPhoneRow and markProspectOutbound", () => {
  const rows: TwentyRecord[] = [
    { id: "rec-1", phoneNumber: "+15557654321", messagingProfileId: "profile-1" },
    { id: "rec-2", phoneNumber: "+15559876543", messagingProfileId: null },
  ];
  const updated: Array<{ id: string; body: unknown }> = [];
  const client = {
    listPage: async () => ({ records: rows, hasNextPage: false, endCursor: null, totalCount: rows.length }),
    listAll: async () => rows,
    update: async (_path: string, id: string, body: unknown) => {
      updated.push({ id, body });
      return { id, ...(body as Record<string, unknown>) };
    },
  } as unknown as TwentyClient;

  test("findAgencyPhoneRow resolves by record id without any client", () => {
    expect(findAgencyPhoneRow(rows, "rec-1")).toEqual({
      record: rows[0],
      phoneNumber: "+15557654321",
      messagingProfileId: "profile-1",
    });
    expect(findAgencyPhoneRow(rows, "missing")).toBeNull();
  });

  test("markProspectOutbound issues the lifecycle update", async () => {
    await markProspectOutbound(client, "rec-1", "SENDING");
    expect(updated).toEqual([{ id: "rec-1", body: { outboundState: "SENDING" } }]);
  });
});
