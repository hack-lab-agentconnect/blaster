/**
 * Do we own the number this inbound event is addressed to?
 *
 * The webhook is a public URL. Without this check, anyone who finds it can
 * post a fabricated `message.received` and fill Blaster's conversation history
 * with threads that belong to numbers nobody here owns. The event's own
 * `to` field is attacker-controlled, so it cannot be the answer.
 *
 * The answer comes from the registries we already maintain: the Telnyx account
 * itself, the Twenty `agencyPhones` mirror, and (once the API has a Convex
 * client) our own purchase ledger. All three are consulted, because each can
 * be a step ahead of the others and a false reject drops a real message.
 *
 * **Fail closed.** When no source is configured at all, the result is
 * `unknown`, not `owned`: a deployment with no number registry has no
 * legitimate inbound either, so rejecting is both the safe answer and the
 * true one. Rejecting is also recoverable — Telnyx retries three times, and
 * the message remains in its Message Detail Records — while accepting a
 * forgery is not.
 */

import { normalizePhoneNumber } from "../../../conversation/history/helpers/pair.ts";
import type { OwnedPhoneNumber } from "../../numbers/helpers/numbers.ts";

/** A number as the Twenty mirror records it. */
export interface MirrorPhoneNumber {
  phoneNumber?: string | null;
  telnyxNumberId?: string | null;
  messagingProfileId?: string | null;
  status?: string | null;
}

/** The registries consulted, in the order they are read. */
export interface OwnershipSources {
  /** The Telnyx account, which is authoritative for what we can send from. */
  telnyx?: readonly OwnedPhoneNumber[] | null;
  /** Twenty `agencyPhones`, the operator-visible mirror. */
  twenty?: readonly MirrorPhoneNumber[] | null;
  /** Our own Convex purchase ledger, once the API can read it. */
  convex?: readonly MirrorPhoneNumber[] | null;
}

export interface OwnedDestination {
  phoneNumber: string;
  source: "telnyx" | "twenty" | "convex";
  telnyxNumberId: string | null;
  /** A number-bound profile wins over the country rule; see resolveMessagingProfile. */
  messagingProfileId: string | null;
  status: string | null;
}

export type DestinationResolution =
  | { status: "owned"; destination: OwnedDestination }
  | { status: "not-owned"; phoneNumber: string; checked: number }
  | { status: "no-sources"; phoneNumber: string };

const norm = (value: string | null | undefined): string => normalizePhoneNumber(value ?? "");

function fromTelnyx(rows: readonly OwnedPhoneNumber[], phoneNumber: string): OwnedDestination | null {
  const hit = rows.find((row) => norm(row.phoneNumber) === phoneNumber);
  return hit
    ? {
        phoneNumber,
        source: "telnyx",
        telnyxNumberId: hit.id,
        messagingProfileId: hit.messagingProfileId,
        status: hit.status,
      }
    : null;
}

function fromMirror(
  source: "twenty" | "convex",
  rows: readonly MirrorPhoneNumber[],
  phoneNumber: string,
): OwnedDestination | null {
  const hit = rows.find((row) => norm(row.phoneNumber) === phoneNumber);
  return hit
    ? {
        phoneNumber,
        source,
        telnyxNumberId: norm(hit.telnyxNumberId) || null,
        messagingProfileId: hit.messagingProfileId ?? null,
        status: hit.status ?? null,
      }
    : null;
}

/**
 * Resolve the event's destination against the registries.
 *
 * Telnyx is read first because it is the only source that proves the number
 * can actually receive a message right now; the mirrors are consulted after
 * so a number we have just purchased through a path that has not yet synced is
 * still accepted rather than dropped.
 */
export function resolveOwnedDestination(
  destination: string,
  sources: OwnershipSources,
): DestinationResolution {
  const phoneNumber = norm(destination);
  if (!phoneNumber) return { status: "not-owned", phoneNumber, checked: 0 };

  const telnyx = sources.telnyx ?? null;
  const twenty = sources.twenty ?? null;
  const convex = sources.convex ?? null;
  if (!telnyx && !twenty && !convex) return { status: "no-sources", phoneNumber };

  const found =
    (telnyx ? fromTelnyx(telnyx, phoneNumber) : null) ??
    (twenty ? fromMirror("twenty", twenty, phoneNumber) : null) ??
    (convex ? fromMirror("convex", convex, phoneNumber) : null);
  if (found) return { status: "owned", destination: found };

  const checked = (telnyx?.length ?? 0) + (twenty?.length ?? 0) + (convex?.length ?? 0);
  return { status: "not-owned", phoneNumber, checked };
}
