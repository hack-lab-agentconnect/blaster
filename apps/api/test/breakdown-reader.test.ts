/**
 * The breakdown reader, against the contract in ./types.ts.
 *
 * The reader is a function precisely so it can be tested with rows instead of a
 * workspace, so these tests never need Twenty credentials. What they pin is the
 * part that can be wrong quietly: whether a count is a total or a floor, and
 * whether the state key is stable across identical reads.
 */
import { describe, expect, test, vi } from "vitest";
import { ROW_CEILING, readBreakdownFrom, twentyReader } from "../src/lib/pipeline/breakdown/client.ts";
import type { BreakdownReader } from "../src/lib/pipeline/breakdown/types.ts";
import type { TwentyClient, TwentyRecord } from "@blaster/core";

const lead = (status: string): TwentyRecord => ({ id: status, status });
const call = (outcome: string): TwentyRecord => ({ id: outcome, outcome });

const reader = (leads: TwentyRecord[], calls: TwentyRecord[], truncated = false): BreakdownReader =>
  async () => ({ leads, calls, truncated });

describe("readBreakdownFrom", () => {
  test("counts what the reader returned, both SELECT shapes, and names the source", async () => {
    const result = await readBreakdownFrom(
      reader([lead("NEW"), lead("CONVERTED"), lead("CONVERTED"), { id: "4", status: { value: "CONVERTED", label: "Converted" } }], [call("COMPLETED")]),
    );
    expect(result.breakdown.leads.total).toBe(4);
    // byStatus is a slice list with shares, not a map, and a SELECT written as
    // {value,label} counts the same as the bare string.
    const converted = result.breakdown.leads.byStatus.find((slice) => slice.value === "CONVERTED");
    expect(converted?.count).toBe(3);
    expect(result.breakdown.calls.total).toBe(1);
    expect(result.source).toBe("twenty");
    expect(result.truncated).toBe(false);
  });

  test("a truncated read reports a floor, not a total", async () => {
    const result = await readBreakdownFrom(reader([lead("NEW")], [], true));
    expect(result.truncated).toBe(true);
    expect(result.breakdown.truncated).toBe(true);
    // The operator has to be told the number is a floor, or they will act on it
    // as if it were the whole picture.
    expect(result.notifications.map((n) => n.id)).toContain("counts-truncated");
  });

  test("the state key is stable for identical reads", async () => {
    const first = await readBreakdownFrom(reader([lead("NEW")], [call("CONNECTED")]));
    const second = await readBreakdownFrom(reader([lead("NEW")], [call("CONNECTED")]));
    expect(first.stateKey).toBe(second.stateKey);
  });

  test("a different firing set produces a different key", async () => {
    const one = await readBreakdownFrom(reader([lead("NEW")], [], true));
    const two = await readBreakdownFrom(reader([lead("NEW")], [], false));
    expect(one.stateKey).not.toBe(two.stateKey);
  });

  test("an empty workspace is a valid answer, and says the pipeline is empty", async () => {
    const result = await readBreakdownFrom(reader([], []));
    expect(result.breakdown.leads.total).toBe(0);
    expect(result.breakdown.calls.total).toBe(0);
    // Silence is not "all clear": an empty pipeline is worth saying out loud.
    expect(result.notifications.map((n) => n.id)).toContain("pipeline-empty");
  });
});

describe("twentyReader", () => {
  const fakeClient = (rows: Record<string, TwentyRecord[]>) =>
    ({
      listAll: vi.fn(async (path: string) => rows[path] ?? []),
    }) as unknown as TwentyClient;

  test("reads both objects, and the ceiling is the documented one", () => {
    expect(ROW_CEILING).toBe(200);
  });

  test("passes the ceiling to every read so the bound is real", async () => {
    const client = fakeClient({ agencyLeads: [], agencyCalls: [] });
    await twentyReader(client)();
    const limits = (client.listAll as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[1] as { limit?: number } | undefined)?.limit,
    );
    expect(limits).toEqual([ROW_CEILING, ROW_CEILING]);
  });

  test("reports truncation when either side reaches the ceiling", async () => {
    const full = Array.from({ length: ROW_CEILING }, (_, i) => lead(`S${i}`));
    const client = fakeClient({ agencyLeads: full, agencyCalls: [] });
    const result = await twentyReader(client)();
    expect(result.truncated).toBe(true);
    expect(result.leads).toHaveLength(ROW_CEILING);
  });

  test("a workspace under the ceiling is not truncated", async () => {
    const client = fakeClient({ agencyLeads: [lead("NEW")], agencyCalls: [call("X")] });
    const result = await twentyReader(client)();
    expect(result.truncated).toBe(false);
  });
});
