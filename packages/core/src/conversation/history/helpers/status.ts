/**
 * Which delivery state wins when two events disagree.
 *
 * Telnyx delivers an event per state change, and it redelivers. A redelivered
 * `message.sent` arriving after a `message.finalized` said `delivered` must not
 * walk the message backwards, or the history starts lying about what the
 * recipient actually got.
 *
 * The rule is a rank, and it is monotone: a state is only written when its rank
 * is strictly higher than what is stored. That makes the outcome independent of
 * arrival order, which is the property that matters when the transport can
 * reorder and repeat.
 *
 *   received 1  <  queued 2  <  sent 3  <  undelivered 4  <  failed 5  <  delivered 6
 *
 * `received` is the inbound state, and it ranks lowest: the rule below is only
 * applied to outbound messages, and a carrier handing us a message is earlier
 * than anything that happens to one we sent.
 *
 * `delivered` outranks the failure states on purpose: if a provider contradicts
 * itself and says both, the recipient having the message is the fact that
 * matters, and it is the one an operator needs to see.
 */

import type { MessageStatus } from "../../../conversation/history/types.ts";

const RANK: Record<MessageStatus, number> = {
  unknown: 0,
  received: 1,
  queued: 2,
  sent: 3,
  undelivered: 4,
  failed: 5,
  delivered: 6,
};

export function statusRank(status: string | null | undefined): number {
  return RANK[status as MessageStatus] ?? 0;
}

/** True when `incoming` is a genuine advance over `current`. */
export function shouldAdvanceStatus(current: string | null | undefined, incoming: string): boolean {
  return statusRank(incoming) > statusRank(current);
}

/** The status to store, or null when the incoming one is not an advance. */
export function nextStatus(
  current: string | null | undefined,
  incoming: string,
): MessageStatus | null {
  if (!shouldAdvanceStatus(current, incoming)) return null;
  return incoming as MessageStatus;
}
