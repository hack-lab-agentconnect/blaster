import { describe, expect, test } from "vitest";
import {
  destinationOf,
  messageIdOf,
  statusOfOutboundEvent,
  verifyTelnyxWebhook,
} from "@blaster/core";

/**
 * Verification is the gate that keeps forged events out of our history, so these
 * tests sign real payloads with a real Ed25519 key rather than stubbing the
 * verifier. A stub would only prove the route calls something; this proves the
 * signature actually has to match.
 */

/** A throwaway Ed25519 keypair. The private half never leaves this file. */
const KEYPAIR = await crypto.subtle.generateKey(
  { name: "Ed25519" },
  true,
  ["sign", "verify"],
) as CryptoKeyPair;

const PUBLIC_KEY = Buffer.from(
  await crypto.subtle.exportKey("raw", KEYPAIR.publicKey),
).toString("base64");

const nowSeconds = (): string => String(Math.floor(Date.now() / 1000));

/** Sign exactly as Telnyx does: timestamp|payload, Ed25519, base64. */
async function sign(payload: string, timestamp: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    KEYPAIR.privateKey,
    new TextEncoder().encode(`${timestamp}|${payload}`),
  );
  return Buffer.from(signature).toString("base64");
}

async function signed(
  payload: string,
  overrides: { timestamp?: string; signature?: string } = {},
): Promise<{ rawBody: string; headers: Record<string, string> }> {
  const timestamp = overrides.timestamp ?? nowSeconds();
  const rawBody = payload;
  return {
    rawBody,
    headers: {
      "telnyx-signature-ed25519": overrides.signature ?? (await sign(rawBody, timestamp)),
      "telnyx-timestamp": timestamp,
      "content-type": "application/json",
    },
  };
}

const EVENT = JSON.stringify({
  data: {
    event_type: "message.received",
    id: "b301ed3f-1490-491f-995f-6e64e69674d4",
    occurred_at: "2024-01-15T20:16:07.588+00:00",
    payload: {
      id: "84cca175-9755-4859-b67f-4730d7f58aa3",
      text: "Is this still the right number to call about pricing?",
      from: { phone_number: "+13125550001" },
      to: [{ phone_number: "+17735550002" }],
      received_at: "2024-01-15T20:16:07.503+00:00",
    },
  },
  meta: { attempt: 1, delivered_to: "https://example.test/api/webhooks/telnyx" },
});

describe("verifyTelnyxWebhook", () => {
  test("accepts a correctly signed body", async () => {
    const { rawBody, headers } = await signed(EVENT);
    await expect(verifyTelnyxWebhook({ rawBody, headers, publicKey: PUBLIC_KEY })).resolves.toEqual({
      outcome: "verified",
      method: "signature",
    });
  });

  test("rejects a body that was altered after signing", async () => {
    const { headers } = await signed(EVENT);
    const tampered = EVENT.replace("pricing", "billing");
    const result = await verifyTelnyxWebhook({ rawBody: tampered, headers, publicKey: PUBLIC_KEY });
    expect(result.outcome).toBe("invalid");
  });

  test("rejects a body re-serialized rather than transmitted verbatim", async () => {
    // Same object, different bytes: the round trip a naive handler would do.
    const { headers } = await signed(EVENT);
    const reserialized = JSON.stringify(JSON.parse(EVENT), null, 2);
    const result = await verifyTelnyxWebhook({ rawBody: reserialized, headers, publicKey: PUBLIC_KEY });
    expect(result.outcome).toBe("invalid");
  });

  test("rejects a missing signature header outright", async () => {
    const result = await verifyTelnyxWebhook({
      rawBody: EVENT,
      headers: { "telnyx-timestamp": nowSeconds() },
      publicKey: PUBLIC_KEY,
    });
    expect(result.outcome).toBe("invalid");
  });

  test("rejects a replayed event outside the timestamp tolerance", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const { rawBody, headers } = await signed(EVENT, { timestamp: stale });
    const result = await verifyTelnyxWebhook({ rawBody, headers, publicKey: PUBLIC_KEY });
    expect(result.outcome).toBe("invalid");
    expect(result.outcome === "invalid" && result.reason).toMatch(/too old/);
  });

  test("reports unavailable, not verified, when nothing is configured", async () => {
    // The defect this replaces: a misconfiguration used to answer 2xx and claim
    // the event was verified.
    const { rawBody, headers } = await signed(EVENT);
    const result = await verifyTelnyxWebhook({ rawBody, headers });
    expect(result.outcome).toBe("unavailable");
  });

  test("falls back to the shared token, and rejects a wrong one", async () => {
    await expect(
      verifyTelnyxWebhook({ rawBody: EVENT, headers: {}, sharedToken: "s3cret", providedToken: "s3cret" }),
    ).resolves.toEqual({ outcome: "shared-token" });
    await expect(
      verifyTelnyxWebhook({ rawBody: EVENT, headers: {}, sharedToken: "s3cret", providedToken: "wrong" }),
    ).resolves.toEqual({ outcome: "invalid", reason: "shared token mismatch" });
  });

  test("a malformed public key is invalid, not a crash", async () => {
    const { rawBody, headers } = await signed(EVENT);
    const result = await verifyTelnyxWebhook({ rawBody, headers, publicKey: "not-a-key" });
    expect(result.outcome).toBe("invalid");
  });
});

describe("event readers", () => {
  const inbound = JSON.parse(EVENT) as Parameters<typeof destinationOf>[0];

  test("reads the destination from the array-shaped to", () => {
    expect(destinationOf(inbound)).toBe("+17735550002");
  });

  test("reads the message id an event refers to", () => {
    expect(messageIdOf(inbound)).toBe("84cca175-9755-4859-b67f-4730d7f58aa3");
  });

  test("an outbound sent event with no status is treated as queued", () => {
    expect(
      statusOfOutboundEvent({
        data: { event_type: "message.sent", payload: { id: "m-1" } },
      }),
    ).toBe("queued");
  });

  test("an explicit provider status wins over the event-type default", () => {
    expect(
      statusOfOutboundEvent({
        data: { event_type: "message.finalized", payload: { id: "m-1", status: "delivered" } },
      }),
    ).toBe("delivered");
  });

  test("an event we have no action for reports no status", () => {
    expect(statusOfOutboundEvent({ data: { event_type: "call.answered" } })).toBeNull();
  });
});
