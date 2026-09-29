import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The webhook, through the real Hono app.
 *
 * Two things are stubbed and two are not, deliberately:
 *
 *   - Real: the Ed25519 signature check, the raw-body handling, the ownership
 *     decision, the status mapping, and the HTTP status chosen for each case.
 *     Those are the parts with the security consequence.
 *   - Stubbed: the two outbound network calls the ownership lookup makes
 *     (Telnyx's owned-number list and Twenty's mirror), and the Convex write.
 *     Convex's own dedupe is covered by its own tests against the deployment.
 */

const OWNED = [{ id: "num-1", phoneNumber: "+17735550002", messagingProfileId: "prof-1", status: "active" }];

const convexCalls: Array<Record<string, unknown>> = [];
let convexResult:
  | { status: "stored"; conversationId: string; messageId: string }
  | { status: "duplicate"; conversationId: string; messageId: string }
  | { status: "not-configured" }
  | { status: "failed"; error: string } = {
  status: "stored",
  conversationId: "conv-1",
  messageId: "msg-1",
};

let statusResult: Record<string, unknown> = { status: "applied", messageId: "msg-1", stored: "delivered" };

vi.mock("@blaster/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blaster/core")>();
  return {
    ...actual,
    listOwnedNumbers: vi.fn(async () => OWNED),
    listAgencyPhones: vi.fn(async () => []),
  };
});

vi.mock("../src/lib/convex/index.ts", () => ({
  recordInboundMessage: async (input: Record<string, unknown>) => {
    convexCalls.push(input);
    return convexResult;
  },
  applyOutboundStatus: async (id: string, status: string) => {
    convexCalls.push({ telnyxMessageId: id, status });
    return statusResult;
  },
}));

const KEYPAIR = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", KEYPAIR.publicKey)).toString("base64");

async function sign(payload: string, timestamp: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      KEYPAIR.privateKey,
      new TextEncoder().encode(`${timestamp}|${payload}`),
    ),
  ).toString("base64");
}

const inboundEvent = (to: string, eventId = "evt-1", messageId = "msg-raw") =>
  JSON.stringify({
    data: {
      event_type: "message.received",
      id: eventId,
      occurred_at: "2024-01-15T20:16:07.588+00:00",
      payload: {
        id: messageId,
        text: "Is this still the right number for pricing?",
        from: { phone_number: "+13125550001" },
        to: [{ phone_number: to }],
        received_at: "2024-01-15T20:16:07.503+00:00",
      },
    },
    meta: { attempt: 1 },
  });

let app: { fetch: (request: Request) => Promise<Response> };

beforeEach(async () => {
  convexCalls.length = 0;
  convexResult = { status: "stored", conversationId: "conv-1", messageId: "msg-1" };
  statusResult = { status: "applied", messageId: "msg-1", stored: "delivered" };
  process.env.TELNYX_PUBLIC_KEY = PUBLIC_KEY;
  process.env.TELNYX_API_KEY = "test-key";
  delete process.env.TWENTY_BASE_URL;
  delete process.env.CONVEX_URL;
  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

afterEach(() => {
  vi.clearAllMocks();
});

async function post(body: string, headers: Record<string, string>) {
  return app.fetch(
    new Request("http://localhost/api/webhooks/telnyx", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

async function postSigned(body: string, tamper = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(body, timestamp);
  return post(body, {
    "telnyx-timestamp": timestamp,
    "telnyx-signature-ed25519": tamper ? Buffer.from("0".repeat(86) + "==").toString("base64") : signature,
  });
}

describe("POST /api/webhooks/telnyx", () => {
  test("a signed event for a number we own is stored", async () => {
    const response = await postSigned(inboundEvent("+17735550002"));
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, event: "message.received", stored: true, duplicate: false });
    expect(convexCalls[0]).toMatchObject({
      from: "+13125550001",
      to: "+17735550002",
      providerEventId: "evt-1",
      telnyxMessageId: "msg-raw",
    });
  });

  test("a redelivery of the same event is acknowledged without a second write", async () => {
    convexResult = { status: "duplicate", conversationId: "conv-1", messageId: "msg-1" };
    const response = await postSigned(inboundEvent("+17735550002"));
    const body = (await response.json()) as Record<string, unknown>;
    // 2xx on a duplicate: the event is durably stored, and a non-2xx would burn
    // a retry on something that is already saved.
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ stored: false, duplicate: true });
  });

  test("an unsigned or tampered event is refused before anything is stored", async () => {
    const response = await postSigned(inboundEvent("+17735550002"), true);
    expect(response.status).toBe(401);
    expect(convexCalls).toHaveLength(0);
  });

  test("an event for a number nobody owns is refused, and not retried", async () => {
    const response = await postSigned(inboundEvent("+15551230000"));
    const body = (await response.json()) as Record<string, unknown>;
    // 202: permanent, so a 2xx stops Telnyx spending attempts on a forgery.
    expect(response.status).toBe(202);
    expect(body).toMatchObject({ stored: false, reason: "destination is not a number we own" });
    expect(convexCalls).toHaveLength(0);
  });

  test("a misconfigured instance refuses rather than claiming success", async () => {
    // This is the defect: previously a missing key still answered 2xx.
    delete process.env.TELNYX_PUBLIC_KEY;
    const body = inboundEvent("+17735550002");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await post(body, { "telnyx-timestamp": timestamp });
    expect(response.status).toBe(503);
    expect(convexCalls).toHaveLength(0);
  });

  test("a store failure is a 500, so Telnyx retries instead of losing the message", async () => {
    convexResult = { status: "failed", error: "convex unavailable" };
    const response = await postSigned(inboundEvent("+17735550002"));
    expect(response.status).toBe(500);
  });

  test("a missing Convex URL is a 503 rather than a silent drop", async () => {
    const module = await import("../src/lib/convex/index.ts");
    vi.spyOn(module, "recordInboundMessage");
    convexResult = { status: "not-configured" };
    const response = await postSigned(inboundEvent("+17735550002"));
    expect(response.status).toBe(503);
  });

  test("a verified event naming no counterpart is acknowledged, not retried forever", async () => {
    const body = JSON.stringify({
      data: { event_type: "message.received", id: "evt-x", payload: { text: "hi" } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await post(body, {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": await sign(body, timestamp),
    });
    expect(response.status).toBe(200);
    expect(convexCalls).toHaveLength(0);
  });

  test("an outbound event updates delivery state instead of storing a message", async () => {
    const body = JSON.stringify({
      data: { event_type: "message.finalized", id: "evt-9", payload: { id: "msg-9", status: "delivered" } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await post(body, {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": await sign(body, timestamp),
    });
    expect(response.status).toBe(200);
    expect(convexCalls[0]).toEqual({ telnyxMessageId: "msg-9", status: "delivered" });
  });

  test("a stale redelivery is reported as such, not applied", async () => {
    statusResult = { status: "stale", messageId: "msg-9", stored: "delivered" };
    const body = JSON.stringify({
      data: { event_type: "message.sent", id: "evt-8", payload: { id: "msg-9" } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await post(body, {
      "telnyx-timestamp": timestamp,
      "telnyx-signature-ed25519": await sign(body, timestamp),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ delivery: "stale" });
  });
});
