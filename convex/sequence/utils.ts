import { PROFILES } from "../../packages/core/src/telnyx/messaging/helpers/profile.js";
import type {
  ProfilePair,
  ScheduledStatus,
  StepFields,
} from "./types.js";

/**
 * Pure helpers for the sequence domain.
 *
 * No `ctx`, no database, no clock, no I/O — which is what makes these the one
 * layer in this domain that can be tested without Convex. Anything here that
 * needed a context belongs in `helpers.ts` instead.
 */

/** Page size a list query uses when the caller does not ask for one. */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Ceiling on a caller-supplied page size.
 *
 * `limit` arrives from a client, so without a ceiling `limit: 1000000` would ask
 * for the table and turn a bounded read back into an unbounded one.
 */
export const MAX_LIST_LIMIT = 200;

/**
 * Coerce an optional caller-supplied page size into a sane one.
 *
 * Floored at 1 so `limit: 0` or a negative number returns an empty page rather
 * than every row, which is what a bare `take()` would do with a negative count.
 */
export function clamp(value: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(value ?? fallback, 1), max);
}

/**
 * The messaging profiles this deployment can send with, in the compact
 * `US=<id>,IE=<id>` form the profile resolver already understands.
 *
 * Built from the Convex `messagingProfiles` table rather than process env, so
 * that table stays the source of truth for a self-hosted install. Countries
 * that could not be normalised are dropped rather than emitted as `=<id>`,
 * which the resolver would read as a country named "".
 */
export function profileEnv(pairs: ProfilePair[]): Record<string, string | undefined> {
  const usable = pairs
    .filter((pair): pair is { country: string; profileId: string } => pair.country !== null)
    .map((pair) => `${pair.country}=${pair.profileId}`);
  const env: Record<string, string | undefined> = {};
  if (usable.length > 0) env[PROFILES.map] = usable.join(",");
  return env;
}

/**
 * Steps in send order.
 *
 * The index range returns them unordered, and the cursor addresses them by
 * position, so sorting here is not cosmetic: an unsorted list would send the
 * wrong message and advance the wrong cursor.
 */
export function stepsInOrder(
  rows: Array<{ order: number; text: string; delayHours: number; isStop: boolean }>,
): StepFields[] {
  return [...rows]
    .sort((a, b) => a.order - b.order)
    .map(({ text, delayHours, isStop }) => ({ text, delayHours, isStop }));
}

/** The step a cursor currently owes, or null when it is past the end. */
export function stepAt(steps: StepFields[], cursor: number): StepFields | null {
  return steps[cursor] ?? null;
}

/**
 * Whether a machine status may be written as a schedule.
 *
 * A guard rather than a cast, so the one case that should be impossible - the
 * machine reporting a state that a reschedule is not allowed to write - is
 * handled and visible instead of being forced to compile.
 *
 * Takes `string` rather than `EnrollmentStatus` because the caller's status
 * arrives from core's decision type as a plain string, and a guard that cannot
 * accept what it is meant to guard would have to be cast away at the call site.
 * Comparing against the four literals is what makes it a guard at all.
 */
export function isScheduledStatus(status: string): status is ScheduledStatus {
  return (
    status === "active" ||
    status === "paused" ||
    status === "awaiting-human" ||
    status === "completed"
  );
}
