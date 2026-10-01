import { describe, expect, test } from "vitest";
import { required, seedPhoneNumber, seedPool, testBackend } from "./harness.js";
import { ref } from "./refs.js";

/**
 * The pool, against a real Convex runtime.
 *
 * These are the regression tests for the defects that shipped silently because
 * every test was a pure unit test. Each one exercises a mutation or query whose
 * behaviour depends on the database, so a pure test could not have seen it.
 */

type Backend = ReturnType<typeof testBackend>;

/** Run `createPool` through its public mutation, so the real defaults apply. */
async function makePool(t: Backend, args: { name: string; minSpacingMs?: number; dailyCapPerNumber?: number }) {
  return t.mutation(ref.createPool, args);
}

describe("pool: membership and rate state", () => {
  test("createPool starts with no members and a cursor behind the first slot", async () => {
    const t = testBackend();
    const poolId = await makePool(t, { name: "Ireland" });
    const pool = required(await t.query(ref.getPool, { poolId: poolId as string }));
    expect(pool).toMatchObject({ name: "Ireland", status: "active", cursor: -1, activeNumberCount: 0 });
    expect(pool.numbers).toEqual([]);
  });

  test("assignNumber creates a ledger row for a number Convex has never seen", async () => {
    // The pool wizard picks from agencyPhones, which is ahead of the Convex
    // ledger, so assignment has to create the row or pooling "our current
    // numbers" fails on everything not yet synced.
    const t = testBackend();
    const poolId = await makePool(t, { name: "P" });
    await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: "+15550000001" });
    const ledger = await t.query(ref.getPhoneNumber, { phoneNumber: "+15550000001" });
    expect(ledger).toMatchObject({ phoneNumber: "+15550000001" });
  });

  test("assignNumber keeps order contiguous and reflects the active count", async () => {
    const t = testBackend();
    const poolId = await makePool(t, { name: "P" });
    for (const number of ["+15550000001", "+15550000002", "+15550000003"]) {
      await seedPhoneNumber(t, number);
      await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: number });
    }
    const pool = required(await t.query(ref.getPool, { poolId: poolId as string }));
    expect(pool.numbers.map((row: { order: number }) => row.order)).toEqual([0, 1, 2]);
    expect(pool.activeNumberCount).toBe(3);
  });

  test("removing a number soft-deletes it and moves the cursor with the survivors", async () => {
    // The compact() defect: renumbering without remapping `pools.cursor`
    // silently changes which member the next pick resumes after.
    const t = testBackend();
    const poolId = await makePool(t, { name: "P" });
    for (const number of ["+15550000001", "+15550000002", "+15550000003"]) {
      await seedPhoneNumber(t, number);
      await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: number });
    }
    // Use the pool once so the cursor lands on the member at order 1.
    await t.run(async (ctx) => {
      // Test-only read of a table this test itself seeded; bounded by the test.
      // eslint-disable-next-line @convex-dev/no-collect-in-query
      const members = await ctx.db.query("poolNumbers").collect();
      const second = members.find((row) => row.order === 1)!;
      await ctx.db.patch("pools", poolId as import("../_generated/dataModel.js").Id<"pools">, { cursor: 1 });
      void second;
    });
    await t.mutation(ref.removeNumber, { poolId: poolId as string, phoneNumber: "+15550000001" });

    const pool = required(await t.query(ref.getPool, { poolId: poolId as string }));
    const live = pool.numbers.filter((row: { status: string }) => row.status !== "removed");
    expect(live.map((row: { order: number }) => row.order)).toEqual([0, 1]);
    // The last-used member (old order 1, now order 0) is still the one the
    // cursor points at, by identity rather than by stale number.
    expect(pool.cursor).toBe(0);
    expect(pool.activeNumberCount).toBe(2);
  });

  test("reorderNumbers repoints the cursor at the same member's new position", async () => {
    const t = testBackend();
    const poolId = await makePool(t, { name: "P" });
    for (const number of ["+15550000001", "+15550000002", "+15550000003"]) {
      await seedPhoneNumber(t, number);
      await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: number });
    }
    await t.run(async (ctx) => ctx.db.patch("pools", poolId as import("../_generated/dataModel.js").Id<"pools">, { cursor: 0 }));
    // Move the member now at order 0 to the end.
    await t.mutation(ref.reorderNumbers, { poolId: poolId as string, order: ["+15550000002", "+15550000003", "+15550000001"] });
    const pool = required(await t.query(ref.getPool, { poolId: poolId as string }));
    // +...001 was the cursor member and is now last.
    expect(pool.cursor).toBe(2);
  });
});

describe("pool: consumeSender reserves the proposed member", () => {
  test("reserves the requested order and advances the cursor to it", async () => {
    const t = testBackend();
    const poolId = await seedPool(t, { minSpacingMs: 0 });
    for (const number of ["+15550000001", "+15550000002"]) {
      await seedPhoneNumber(t, number, "prof-x");
      await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: number });
    }
    const chosen = await t.query(ref.availableSender, { poolId: poolId as string });
    expect(chosen.sender).toMatchObject({ phoneNumber: "+15550000001", order: 0 });

    const reserved = await t.mutation(ref.consumeSender, { poolId: poolId as string, order: 0 });
    expect(reserved.sender).toMatchObject({ phoneNumber: "+15550000001", order: 0 });

    const pool = required(await t.query(ref.getPool, { poolId: poolId as string }));
    expect(pool.cursor).toBe(0);
    const first = required(pool.numbers.find((row: { order: number }) => row.order === 0));
    expect(first.sentToday).toBe(1);
  });

  test("refuses rather than substituting a different number than the one proposed", async () => {
    // The TOCTOU defect: re-selecting would send from a number whose profile
    // eligibility never saw and whose token bucket was never charged.
    const t = testBackend();
    const poolId = await seedPool(t, { minSpacingMs: 0 });
    for (const number of ["+15550000001", "+15550000002"]) {
      await seedPhoneNumber(t, number, "prof-x");
      await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: number });
    }
    // Propose order 1, then remove that member before consuming it.
    await t.mutation(ref.removeNumber, { poolId: poolId as string, phoneNumber: "+15550000002" });
    const reserved = await t.mutation(ref.consumeSender, { poolId: poolId as string, order: 1 });
    expect(reserved.sender).toBeNull();
  });

  test("a paused pool reserves nothing", async () => {
    const t = testBackend();
    const poolId = await seedPool(t, { status: "paused" });
    await seedPhoneNumber(t, "+15550000001", "prof-x");
    await t.mutation(ref.assignNumber, { poolId: poolId as string, phoneNumber: "+15550000001" });
    const reserved = await t.mutation(ref.consumeSender, { poolId: poolId as string, order: 0 });
    expect(reserved.sender).toBeNull();
  });
});
