/**
 * The pair key: the one thing that makes a conversation a conversation.
 *
 * Two rules, and both exist because a real number arrives in more than one
 * shape:
 *
 *   1. Normalize to E.164 before keying. The same number reaches us as
 *      "+13125550001" from Telnyx, as "13125550001" in a CLI flag, and as
 *      "313-125-550001" in anything a human typed. Three keys would be three
 *      conversations.
 *   2. Order the pair, not the roles. An inbound event reports the peer as
 *      `from`, an outbound one as `to`; keying on the raw ordering would split
 *      the same thread in two. Sorting the two numbers makes the key
 *      direction-independent, and the roles are recovered from the direction.
 */

import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { CountryCode } from "libphonenumber-js";

const DEFAULT_REGION = "US";

/**
 * Best-effort E.164. Returns the input trimmed when it cannot be parsed, so a
 * malformed number still produces a stable key instead of throwing inside a
 * webhook and losing the message. A number that cannot be normalized is a
 * warning, not a failure: the message still belongs somewhere.
 *
 * Country detection goes through libphonenumber-js rather than a hand-kept
 * table, the same call the messaging profile resolver already makes.
 */
export function normalizePhoneNumber(raw: string, defaultRegion: string = DEFAULT_REGION): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Fast path: already E.164.
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;
  // The region arrives as a plain string because it comes from configuration
  // and a CLI flag; the library wants its own country union, and an
  // unrecognised code degrades to the trimmed input rather than throwing.
  const options = { defaultCountry: defaultRegion as CountryCode };
  return parsePhoneNumberFromString(trimmed, options)?.number ?? trimmed;
}

/**
 * The conversation key for a pair of numbers. Direction-independent by
 * construction, so the inbound event and the outbound send that follow it
 * resolve to the same conversation.
 */
export function conversationPairKey(peerNumber: string, blasterNumber: string): string {
  const a = normalizePhoneNumber(peerNumber);
  const b = normalizePhoneNumber(blasterNumber);
  return [a, b].sort().join("|");
}

/** Recover the peer from a pair key, given the Blaster number in play. */
export function peerFromPairKey(pairKey: string, blasterNumber: string): string {
  const blaster = normalizePhoneNumber(blasterNumber);
  const parts = pairKey.split("|");
  return parts.find((part) => part !== blaster) ?? parts[0] ?? "";
}
