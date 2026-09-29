/**
 * Reading a verified Telnyx event.
 *
 * Two shapes in one function's worth of documentation decide everything here,
 * and both are easy to get wrong:
 *
 *   - `data.payload.from` is an object but `data.payload.to` is an *array* on
 *     an inbound event, and the reverse is not true outbound. A mapper written
 *     for one shape silently drops the peer on the other.
 *   - `data.id` is the event and `data.payload.id` is the message. Telnyx
 *     retries the same event, so `data.id` is the dedupe key; the message id
 *     alone would let a retry through as a duplicate.
 *
 * Nothing here throws on a missing field. A webhook that throws inside a
 * mapper has already spent its 2-second acknowledgement budget, and Telnyx
 * only retries three times.
 */

import type { InboundMessageInput, MessageStatus } from "../types.ts";
import { normalizePhoneNumber } from "./pair.ts";

/**
 * The address object as Telnyx sends it. Only `phone_number` is read here, but
 * the rest of the documented fields are declared so a real payload is a valid
 * `TelnyxWebhookEvent` rather than an excess-property error at every call site.
 */
interface TelnyxAddress {
  phone_number?: unknown;
  carrier?: unknown;
  line_type?: unknown;
  status?: unknown;
}

interface TelnyxMedia {
  url?: unknown;
  content_type?: unknown;
  size?: unknown;
}

export interface TelnyxWebhookEvent {
  data?: {
    event_type?: unknown;
    id?: unknown;
    occurred_at?: unknown;
    record_type?: unknown;
    payload?: {
      id?: unknown;
      text?: unknown;
      from?: TelnyxAddress;
      to?: TelnyxAddress[] | TelnyxAddress;
      media?: TelnyxMedia[];
      received_at?: unknown;
      sent_at?: unknown;
      status?: unknown;
      direction?: unknown;
      parts?: unknown;
      tags?: unknown;
    };
  };
  /** Delivery bookkeeping, which the retry logic depends on and we log. */
  meta?: {
    attempt?: number;
    delivered_to?: string;
  };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** `to` is an array inbound and an object outbound; accept either. */
function firstPhone(address: TelnyxAddress[] | TelnyxAddress | undefined): string {
  if (Array.isArray(address)) return str(address[0]?.phone_number);
  return str(address?.phone_number);
}

function toMillis(value: unknown): number | null {
  const parsed = Date.parse(str(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function media(input: TelnyxMedia[] | undefined) {
  if (!Array.isArray(input) || input.length === 0) return undefined;
  const mapped = input
    .filter((item) => str(item.url) !== "")
    .map((item) => ({
      url: str(item.url),
      ...(str(item.content_type) ? { contentType: str(item.content_type) } : {}),
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    }));
  return mapped.length > 0 ? mapped : undefined;
}

/** The event types that carry a message we store. */
export const INBOUND_EVENT = "message.received";
export const OUTBOUND_EVENTS = new Set(["message.sent", "message.finalized"]);

export function isInboundEvent(event: TelnyxWebhookEvent): boolean {
  return str(event.data?.event_type) === INBOUND_EVENT;
}

export function eventTypeOf(event: TelnyxWebhookEvent): string {
  return str(event.data?.event_type);
}

/** Map a verified `message.received` event. Returns null when unusable. */
export function readInboundMessage(event: TelnyxWebhookEvent): InboundMessageInput | null {
  if (!isInboundEvent(event)) return null;
  const payload = event.data?.payload ?? {};
  const from = normalizePhoneNumber(firstPhone(payload.from));
  const to = normalizePhoneNumber(firstPhone(payload.to));
  // Without both ends there is no conversation to attach this to, and a
  // half-keyed message is worse than a reported gap.
  if (!from || !to) return null;
  return {
    telnyxMessageId: str(payload.id) || null,
    providerEventId: str(event.data?.id) || null,
    from,
    to,
    body: str(payload.text),
    receivedAt: toMillis(payload.received_at) ?? toMillis(event.data?.occurred_at) ?? Date.now(),
    ...(media(payload.media) ? { media: media(payload.media) } : {}),
  };
}

/** Collapse a Telnyx delivery state to what the surfaces display. */
export function readOutboundStatus(state: string): MessageStatus {
  switch (state.toLowerCase()) {
    case "queued":
    case "accepted":
      return "queued";
    case "sent":
    case "sending":
      return "sent";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    case "undelivered":
      return "undelivered";
    default:
      return "unknown";
  }
}
