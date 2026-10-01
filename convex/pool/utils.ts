import type { PoolMemberState } from "../../packages/core/src/pipeline/pool/index.js";

/**
 * Pure helpers for the pool domain.
 *
 * No `ctx`, no database, no clock, no I/O — which is what makes these testable
 * without Convex. The selection arithmetic itself lives in `packages/core`, this
 * file only adapts stored rows to the shape the core reads.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A second between sends from one number, the conservative default. */
export const DEFAULT_MIN_SPACING_MS = 1_000;

/** No per-number daily cap by default; the operator sets a real one. */
export const DEFAULT_DAILY_CAP_PER_NUMBER = 0;

/** Page size a pool list uses; a pool is a bounded config table. */
export const DEFAULT_LIST_LIMIT = 50;

/** The subset of a `poolNumbers` row the pure selection reads. */
export interface PoolMemberRow {
  order: number;
  status: "active" | "paused" | "removed";
  nextAvailableAt: number;
  sentToday: number;
  dayStartedAt: number;
}

/** Adapt a stored row to the pure core shape. */
export function memberState(row: PoolMemberRow): PoolMemberState {
  return {
    order: row.order,
    status: row.status,
    nextAvailableAt: row.nextAvailableAt,
    sentToday: row.sentToday,
    dayStartedAt: row.dayStartedAt,
  };
}

/** Coerce an optional caller-supplied rate setting into a non-negative number. */
export function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
