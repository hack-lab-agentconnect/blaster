import { describe, expect, test } from "vitest";
import { unwrapItem, unwrapList, combineFilters, selectValue } from "../src/twenty/crm/helpers/client.ts";
import {
  buildBreakdown,
  evaluateNotifications,
  notificationStateKey,
} from "../src/pipeline/breakdown/helpers/build.ts";

describe("unwrapList", () => {
  test("a bare array", () => {
    expect(unwrapList([{ id: "1" }], "agencyLeads")).toEqual([{ id: "1" }]);
  });

  test("the plural-keyed envelope", () => {
    expect(unwrapList({ data: { agencyLeads: [{ id: "1" }] } }, "agencyLeads")).toEqual([{ id: "1" }]);
  });

  test("the doubly-nested envelope", () => {
    expect(unwrapList({ data: { data: { agencyLeads: [{ id: "1" }] } } }, "agencyLeads")).toHaveLength(1);
  });

  test("the singular-keyed envelope", () => {
    expect(unwrapList({ data: { agencyLead: [{ id: "1" }] } }, "agencyLeads")).toHaveLength(1);
  });

  test("a rows envelope", () => {
    expect(unwrapList({ data: { rows: [{ id: "1" }] } }, "agencyLeads")).toHaveLength(1);
  });

  test("a GraphQL edges envelope", () => {
    expect(unwrapList({ data: { edges: [{ node: { id: "1" } }, { node: { id: "2" } }] } }, "agencyLeads"))
      .toEqual([{ id: "1" }, { id: "2" }]);
  });

  test("an unrecognised shape yields no records rather than throwing", () => {
    expect(unwrapList({ data: { somethingElse: 1 } }, "agencyLeads")).toEqual([]);
    expect(unwrapList(null, "agencyLeads")).toEqual([]);
  });
});

describe("unwrapItem", () => {
  test("a bare record", () => {
    expect(unwrapItem({ data: { id: "abc" } }, "agencyLeads")).toEqual({ id: "abc" });
  });

  test("a singular wrapper", () => {
    expect(unwrapItem({ data: { agencyLead: { id: "abc" } } }, "agencyLeads")).toEqual({ id: "abc" });
  });

  test("nothing recognisable", () => {
    expect(unwrapItem({ data: {} }, "agencyLeads")).toBeNull();
  });
});

describe("selectValue", () => {
  test("a bare string", () => {
    expect(selectValue("CONVERTED")).toBe("CONVERTED");
  });

  test("a composite written as value and label", () => {
    expect(selectValue({ value: "CONVERTED", label: "Converted" })).toBe("CONVERTED");
  });

  test("falls back to the label when there is no value", () => {
    expect(selectValue({ label: "Converted" })).toBe("Converted");
  });

  test("empty and absent", () => {
    expect(selectValue("")).toBeUndefined();
    expect(selectValue(undefined)).toBeUndefined();
    expect(selectValue(null)).toBeUndefined();
  });
});

describe("combineFilters", () => {
  test("combines a filter with a cursor", () => {
    expect(combineFilters('name[eq]:x', "abc")).toBe('(name[eq]:x) AND id[gt]:"abc"');
  });

  test("either alone", () => {
    expect(combineFilters("name[eq]:x", undefined)).toBe("name[eq]:x");
    expect(combineFilters(undefined, "abc")).toBe('id[gt]:"abc"');
  });
});

const leads = [
  { id: "1", status: "NEW" },
  { id: "2", status: { value: "CONVERTED", label: "Converted" } },
  { id: "3", status: "CONVERTED" },
  { id: "4", status: "DO_NOT_CONTACT" },
];

const calls = [
  { id: "c1", outcome: "COMPLETED", durationSeconds: 120 },
  { id: "c2", outcome: "COMPLETED", durationSeconds: 60 },
  { id: "c3", outcome: "NO_ANSWER", durationSeconds: 0 },
];

describe("buildBreakdown", () => {
  const breakdown = buildBreakdown({ leads, calls });

  test("counts a SELECT written as a string and as a composite the same", () => {
    const converted = breakdown.leads.byStatus.find((slice) => slice.value === "CONVERTED");
    expect(converted?.count).toBe(2);
  });

  test("shares sum to 100 across classified records", () => {
    const total = breakdown.leads.byStatus.reduce((sum, slice) => sum + slice.share, 0);
    expect(Math.round(total)).toBe(100);
  });

  test("the answer rate uses answered over total", () => {
    expect(breakdown.calls.answered).toBe(2);
    expect(breakdown.calls.answerRate).toBe(66.7);
  });

  test("the average duration averages every call, not just answered ones", () => {
    expect(breakdown.calls.averageDurationSeconds).toBe(60);
  });

  test("conversion is converted over classified leads", () => {
    expect(breakdown.conversion.rate).toBe(50);
  });

  test("empty input does not divide by zero", () => {
    const empty = buildBreakdown({ leads: [], calls: [] });
    expect(empty.leads.total).toBe(0);
    expect(empty.calls.answerRate).toBe(0);
    expect(empty.conversion.rate).toBe(0);
  });
});

describe("notifications", () => {
  test("a do-not-contact share at or above a quarter fires and is critical", () => {
    const breakdown = buildBreakdown({ leads, calls });
    const fired = evaluateNotifications(breakdown);
    const dnc = fired.find((notification) => notification.id === "do-not-contact-spike");
    expect(dnc?.severity).toBe("critical");
    expect(fired[0]?.severity).toBe("critical");
  });

  test("an empty pipeline fires the pipeline-empty warning", () => {
    const fired = evaluateNotifications(buildBreakdown({ leads: [], calls: [] }));
    expect(fired.map((notification) => notification.id)).toContain("pipeline-empty");
  });

  test("truncated counts are reported as a floor, not a total", () => {
    const fired = evaluateNotifications(buildBreakdown({ leads, calls, truncated: true }));
    expect(fired.map((notification) => notification.id)).toContain("counts-truncated");
  });

  test("a healthy pipeline fires nothing critical", () => {
    const healthy = buildBreakdown({
      leads: [
        { id: "1", status: "CONVERTED" },
        { id: "2", status: "CONTACTED" },
      ],
      calls: [
        { id: "c1", outcome: "COMPLETED", durationSeconds: 90 },
        { id: "c2", outcome: "COMPLETED", durationSeconds: 90 },
        { id: "c3", outcome: "COMPLETED", durationSeconds: 90 },
        { id: "c4", outcome: "COMPLETED", durationSeconds: 90 },
        { id: "c5", outcome: "COMPLETED", durationSeconds: 90 },
      ],
    });
    expect(evaluateNotifications(healthy)).toEqual([]);
  });

  test("the state key changes when the firing set changes", () => {
    const one = evaluateNotifications(buildBreakdown({ leads, calls }));
    const two = evaluateNotifications(buildBreakdown({ leads, calls, truncated: true }));
    expect(notificationStateKey(one)).not.toBe(notificationStateKey(two));
  });

  test("the same firing set produces a stable key regardless of order", () => {
    const breakdown = buildBreakdown({ leads, calls });
    expect(notificationStateKey(evaluateNotifications(breakdown)))
      .toBe(notificationStateKey(evaluateNotifications(breakdown)));
  });
});
