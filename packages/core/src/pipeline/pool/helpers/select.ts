/**
 * Sequential dispatch under per-number rate limits.
 *
 * The pool is worked in `order`, one number at a time, wrapping to the front
 * when it reaches the end. A number is skipped while it is cooling down (its
 * spacing has not elapsed) or over its daily cap, and the walk moves on to the
 * next. This is the whole anti-limit-queue mechanism: rather than hand a number
 * more than it may send, the pool reports the instant it will next be ready and
 * the runner defers.
 *
 * `cursor` is the `order` of the member most recently used, so the walk resumes
 * where it left off instead of always starting at the first number.
 */

import type { PoolMemberState, PoolPolicy, SenderSelection } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a member next becomes able to send.
 *
 * A returned value `<= now` means it can send now. The daily cap pushes the
 * answer to the end of the current day window rather than to `nextAvailableAt`,
 * because a number out of daily budget is unavailable until the window rolls
 * even when its spacing has long elapsed.
 */
export function availableAt(member: PoolMemberState, now: number, policy: PoolPolicy): number {
  const rolled = now - member.dayStartedAt >= DAY_MS;
  let at = member.nextAvailableAt;
  if (!rolled && policy.dailyCapPerNumber > 0 && member.sentToday >= policy.dailyCapPerNumber) {
    at = Math.max(at, member.dayStartedAt + DAY_MS);
  }
  return at;
}

/**
 * The next member that may send, in pool order, starting after `cursor`.
 *
 * `members` need not be sorted; they are ordered here so the cursor arithmetic
 * has one implementation. Non-active members are ignored entirely, including a
 * removed one whose counters are still on disk.
 */
export function selectSender(
  members: PoolMemberState[],
  cursor: number,
  now: number,
  policy: PoolPolicy,
): SenderSelection {
  const active = members
    .filter((member) => member.status === "active")
    .sort((a, b) => a.order - b.order);
  if (active.length === 0) return { order: null, soonestNextAvailableAt: null };

  // Resume after the last-used order, wrapping. `cursor` is a position in the
  // sequence, not an array index, so it is compared as a value.
  const firstAfter = active.findIndex((member) => member.order > cursor);
  const start = firstAfter === -1 ? 0 : firstAfter;
  const ordered = [...active.slice(start), ...active.slice(0, start)];

  let soonest: number | null = null;
  for (const member of ordered) {
    const at = availableAt(member, now, policy);
    if (at <= now) return { order: member.order, soonestNextAvailableAt: null };
    soonest = soonest === null ? at : Math.min(soonest, at);
  }
  return { order: null, soonestNextAvailableAt: soonest };
}
