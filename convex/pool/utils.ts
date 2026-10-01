import type { PoolMemberState } from "../../packages/core/src/pipeline/pool/index.js";
import { TELNYX_PER_NUMBER_PERIOD_MS } from "../rateLimit.js";

/**
 * Pure helpers for the pool domain.
 *
 * No `ctx`, no database, no clock, no I/O — which is what makes these testable
 * without Convex. The selection arithmetic itself lives in `packages/core`, this
 * file only adapts stored rows to the shape the core reads.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A pool number's default pacing floor: the send rate limiter's per-number
 * period (see convex/rateLimit.ts, `telnyxSendPerNumber`).
 *
 * The pool paces, the limiter admits. Deriving this from the limiter's own
 * period is what keeps the two from competing: a pool that handed out a number
 * faster than the bucket refills would only ever earn a refusal, and one that
 * paced much slower would leave throughput unused. The limiter remains
 * authoritative either way, because the runner defers when it refuses.
 */
export const DEFAULT_MIN_SPACING_MS = TELNYX_PER_NUMBER_PERIOD_MS;

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
