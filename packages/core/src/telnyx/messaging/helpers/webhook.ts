/**
 * Verifying a Telnyx webhook, and refusing to when we cannot.
 *
 * Telnyx signs the exact bytes it sent, as `timestamp|raw-body`, with Ed25519
 * and two headers. The body therefore has to be the untouched text: parsing it
 * into an object and re-serializing it changes the bytes and the signature no
 * longer matches. That is why this takes a string, and why the route reads the
 * body before it touches anything.
 *
 * Two failure modes are kept apart on purpose:
 *
 *   - `invalid` means the event did not come from Telnyx. A 401 is correct, and
 *     Telnyx is not going to keep retrying a signature it believes is good.
 *   - `unavailable` means we could not check: no public key configured, or the
 *     cryptography itself failed. Answering 2xx there would accept unverified
 *     input, which is the defect this replaces.
 *
 * This lives in core because core is what depends on the Telnyx SDK, and
 * because "did this event really come from Telnyx" is domain logic, not
 * transport: the HTTP route should only have to decide what to do with the
 * answer.
 */

import { TelnyxWebhook } from "telnyx/lib/webhooks";
import { eventTypeOf, type TelnyxWebhookEvent } from "../../../conversation/history/index.ts";

export type WebhookVerification =
  | { outcome: "verified"; method: "signature" }
  | { outcome: "shared-token" }
  | { outcome: "invalid"; reason: string }
  | { outcome: "unavailable"; reason: string };

export interface VerifyWebhookOptions {
  /** The unmodified request body. Any re-serialization breaks the signature. */
  rawBody: string;
  /** Header record; the SDK reads it with Object.entries, so pass a plain object. */
  headers: Record<string, string>;
  publicKey?: string | undefined;
  sharedToken?: string | undefined;
  /** Compared against the `token` query parameter, for the shared-secret gate. */
  providedToken?: string | undefined;
}

export async function verifyTelnyxWebhook(
  options: VerifyWebhookOptions,
): Promise<WebhookVerification> {
  if (options.publicKey) {
    try {
      // The SDK's own Ed25519 check, including its five-minute timestamp
      // tolerance, which is what stops a captured event being replayed later.
      await new TelnyxWebhook(options.publicKey).verify(options.rawBody, options.headers);
      return { outcome: "verified", method: "signature" };
    } catch (error) {
      return { outcome: "invalid", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  if (options.sharedToken) {
    return options.providedToken === options.sharedToken
      ? { outcome: "shared-token" }
      : { outcome: "invalid", reason: "shared token mismatch" };
  }

  // No key and no token is a misconfiguration, not an open door.
  return {
    outcome: "unavailable",
    reason: "no TELNYX_PUBLIC_KEY or TELNYX_WEBHOOK_TOKEN configured",
  };
}

/**
 * The number an inbound event is addressed to, for the ownership check.
 *
 * `to` is an array on inbound and an object outbound, which is why this exists
 * rather than a field read at the call site.
 */
export function destinationOf(event: TelnyxWebhookEvent): string | null {
  const to = event.data?.payload?.to;
  const address = Array.isArray(to) ? to[0]?.phone_number : to?.phone_number;
  return typeof address === "string" && address !== "" ? address : null;
}

/** The delivery state an outbound event reports, for the precedence rule. */
export function statusOfOutboundEvent(event: TelnyxWebhookEvent): string | null {
  const payload = event.data?.payload as { status?: unknown } | undefined;
  if (typeof payload?.status === "string" && payload.status !== "") return payload.status;
  return eventTypeOf(event) === "message.sent" ? "queued" : null;
}

/** The Telnyx message id an event refers to, when it names one. */
export function messageIdOf(event: TelnyxWebhookEvent): string | null {
  const id = event.data?.payload?.id;
  return typeof id === "string" && id !== "" ? id : null;
}
