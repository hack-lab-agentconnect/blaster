/**
 * The number pool's contract: which number may send next, and when.
 *
 * A pool is an ordered set of sending numbers with a rate budget each. The one
 * rule the types exist to enforce: **the pool decides whether a send may happen
 * now, and a "no" is a schedule, not a drop.** A number at its limit must not
 * be handed a message the carrier will reject into its limit queue; the caller
 * defers to the instant the pool is next able to send.
 *
 * Everything here is pure over plain data, so the rate arithmetic is tested with
 * no database and no clock, the same way the sequence state machine is.
 */

/** Where a number sits in a pool. `removed` keeps the audit without sending. */
export type PoolMemberStatus = "active" | "paused" | "removed";

/** The rate budget a pool imposes on each of its numbers. */
export interface PoolPolicy {
  /** Minimum gap between two sends from the same number. */
  minSpacingMs: number;
  /** Messages per number per rolling day. 0 disables the cap. */
  dailyCapPerNumber: number;
}

/**
 * The runtime state of one pool member.
 *
 * `nextAvailableAt` carries the spacing budget and `sentToday`/`dayStartedAt`
 * carry the daily budget; together they are the relational status the pool is
 * tracked by. Deliberately plain numbers rather than dates, so the core stays
 * clock-free and a test can pin `now`.
 */
export interface PoolMemberState {
  /** Position in the pool. Dispatch walks these in ascending order. */
  order: number;
  status: PoolMemberStatus;
  /** Earliest the number may send again; 0 when it never has. */
  nextAvailableAt: number;
  /** Messages sent in the window that began at `dayStartedAt`. */
  sentToday: number;
  /** Start of the window `sentToday` counts over. */
  dayStartedAt: number;
}

/**
 * What the pool decided.
 *
 * `order` names the member to send from. When it is null nothing may send now,
 * and `soonestNextAvailableAt` is the instant to try again — never null in that
 * case unless the pool has no active numbers at all, which is a different
 * situation the caller parks for a human rather than retries.
 */
export interface SenderSelection {
  order: number | null;
  soonestNextAvailableAt: number | null;
}
