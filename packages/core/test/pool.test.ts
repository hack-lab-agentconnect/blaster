import { describe, expect, test } from "vitest";
import { availableAt, selectSender } from "../src/pipeline/pool/index.ts";
import type { PoolMemberState, PoolPolicy } from "../src/pipeline/pool/index.ts";

/**
 * Sequential dispatch under per-number rate limits.
 *
 * The property that matters is the one the pool exists for: when no number may
 * send, selection must report *when* one next can, so the caller defers instead
 * of handing the carrier a message it will reject into its limit queue.
 */

const DAY = 24 * 60 * 60 * 1000;
const policy: PoolPolicy = { minSpacingMs: 1_000, dailyCapPerNumber: 0 };

function member(overrides: Partial<PoolMemberState> & { order: number }): PoolMemberState {
  return {
    status: "active",
    nextAvailableAt: 0,
    sentToday: 0,
    dayStartedAt: 0,
    ...overrides,
  };
}

describe("selectSender", () => {
  test("picks the first member in order when all are available", () => {
    const members = [member({ order: 0 }), member({ order: 1 }), member({ order: 2 })];
    expect(selectSender(members, -1, 1_000, policy)).toEqual({ order: 0, soonestNextAvailableAt: null });
  });

  test("resumes after the cursor rather than restarting at the first", () => {
    const members = [member({ order: 0 }), member({ order: 1 }), member({ order: 2 })];
    expect(selectSender(members, 1, 1_000, policy).order).toBe(2);
  });

  test("wraps to the front when the cursor is at the end", () => {
    const members = [member({ order: 0 }), member({ order: 1 }), member({ order: 2 })];
    expect(selectSender(members, 2, 1_000, policy).order).toBe(0);
  });

  test("skips a number that is cooling down and uses the next", () => {
    const members = [
      member({ order: 0, nextAvailableAt: 5_000 }),
      member({ order: 1, nextAvailableAt: 0 }),
    ];
    expect(selectSender(members, -1, 1_000, policy)).toEqual({ order: 1, soonestNextAvailableAt: null });
  });

  test("reports the soonest instant when every number is cooling down", () => {
    const members = [
      member({ order: 0, nextAvailableAt: 9_000 }),
      member({ order: 1, nextAvailableAt: 4_000 }),
    ];
    expect(selectSender(members, -1, 1_000, policy)).toEqual({
      order: null,
      soonestNextAvailableAt: 4_000,
    });
  });

  test("a daily cap defers to the end of the member's day window", () => {
    const capped: PoolPolicy = { minSpacingMs: 1_000, dailyCapPerNumber: 2 };
    const members = [member({ order: 0, sentToday: 2, dayStartedAt: 0 })];
    // The window began at 0, so the cap lifts at DAY.
    expect(availableAt(members[0] as PoolMemberState, 1_000, capped)).toBe(DAY);
    expect(selectSender(members, -1, 1_000, capped)).toEqual({
      order: null,
      soonestNextAvailableAt: DAY,
    });
  });

  test("a rolled-over day forgives yesterday's count", () => {
    const capped: PoolPolicy = { minSpacingMs: 1_000, dailyCapPerNumber: 2 };
    const members = [member({ order: 0, sentToday: 5, dayStartedAt: 0 })];
    expect(availableAt(members[0] as PoolMemberState, DAY + 1, capped)).toBe(0);
    expect(selectSender(members, -1, DAY + 1, capped).order).toBe(0);
  });

  test("paused and removed numbers are never chosen", () => {
    const members = [
      member({ order: 0, status: "paused" }),
      member({ order: 1, status: "removed" }),
      member({ order: 2 }),
    ];
    expect(selectSender(members, -1, 1_000, policy).order).toBe(2);
  });

  test("an empty active set reports nothing to wait for", () => {
    const members = [member({ order: 0, status: "removed" })];
    expect(selectSender(members, -1, 1_000, policy)).toEqual({
      order: null,
      soonestNextAvailableAt: null,
    });
  });
});
