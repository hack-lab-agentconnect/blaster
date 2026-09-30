import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Call recordings and transcripts through the real Hono app.
 *
 * What is real here is the part with a security consequence: the Ed25519
 * signature check and the raw-body handling, because a call event that skipped
 * verification would let a stranger write into the call history. The Twenty
 * transport is stubbed at `fetch`, which is the same boundary the existing
 * webhook test uses for Convex.
 *
 * The call events share the receiver with messaging on purpose, so these tests
 * also pin the routing: a call event must reach the call history and must not be
 * swallowed by the conversation path.
 */

type Write = { method: string; url: string; body: Record<string, unknown> };

let writes: Write[] = [];
let existingRows: Record<string, unknown>[] = [];
let twentyStatus = 200;

vi.mock("@blaster/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blaster/core")>();
  return {
    ...actual,
    listOwnedNumbers: vi.fn(async () => []),
    listAgencyPhones: vi.fn(async () => []),
  };
});

const KEYPAIR = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey("raw", KEYPAIR.publicKey)).toString("base64");

async function sign(payload: string, timestamp: string): Promise<string> {
  return Buffer.from(
    await crypto.subtle.sign({ name: "Ed25519" }, KEYPAIR.privateKey, new TextEncoder().encode(`${timestamp}|${payload}`)),
  ).toString("base64");
}

const callEvent = (eventType: string, payload: Record<string, unknown>) =>
  JSON.stringify({ data: { event_type: eventType, id: "evt-1", payload }, meta: { attempt: 1 } });

const savedRecording = callEvent("call.recording.saved", {
  call_control_id: "cc-1",
  recording_id: "rec-1",
  recording_urls: { mp3: "https://rec/1.mp3" },
  from: "+13125550001",
  to: "+17735550002",
});

const savedTranscript = callEvent("call.recording.transcription.saved", {
  call_control_id: "cc-1",
  transcript: "agent: how are you? prospect: fine.",
  from: "+13125550001",
  to: "+17735550002",
});

let app: { fetch: (request: Request) => Promise<Response> };

beforeEach(async () => {
  writes = [];
  existingRows = [];
  twentyStatus = 200;
  process.env.TELNYX_PUBLIC_KEY = PUBLIC_KEY;
  process.env.TWENTY_BASE_URL = "https://twenty.test";
  process.env.TWENTY_API_KEY = "test-key";
  // The webhook is a machine-to-machine write, so there is no operator to
  // attribute it to and AI is off unless configured.
  delete process.env.OPENAI_API_KEY;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes("/rest/agencyCalls")) {
        throw new Error(`unexpected fetch in this test: ${url}`);
      }
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      writes.push({ method, url, body });
      if (twentyStatus !== 200) {
        return new Response("not found", { status: twentyStatus });
      }
      if (method === "GET") {
        return new Response(JSON.stringify({ data: { agencyCalls: existingRows } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (method === "POST") return new Response(JSON.stringify({ data: { agencyCall: { id: "call-new" } } }), { status: 200 });
      return new Response(JSON.stringify({ data: { agencyCall: { id: "call-1" } } }), { status: 200 });
    }),
  );

  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function postSigned(body: string, tamper = false) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return app.fetch(
    new Request("http://localhost/api/webhooks/telnyx", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "telnyx-timestamp": timestamp,
        "telnyx-signature-ed25519": tamper
          ? Buffer.from("0".repeat(86) + "==").toString("base64")
          : await sign(body, timestamp),
      },
      body,
    }),
  );
}

const patchBody = () => writes.find((write) => write.method === "PATCH")?.body ?? {};

describe("call events on the Telnyx receiver", () => {
  test("a signed recording for an unknown call creates the row", async () => {
    const response = await postSigned(savedRecording);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, event: "call.recording.saved" });
    expect((body.call as Record<string, unknown>).outcome).toBe("created");
    const created = writes.find((write) => write.method === "POST");
    expect(created?.body).toMatchObject({
      telnyxCallId: "cc-1",
      telnyxRecordingId: "rec-1",
      recordingUrl: "https://rec/1.mp3",
      transcriptionStatus: "PENDING",
      direction: "UNKNOWN",
    });
  });

  test("a recording for a call we already track attaches instead of duplicating", async () => {
    existingRows = [
      { id: "call-1", telnyxCallId: "cc-1", fromNumber: "+13125550001", toNumber: "+17735550002" },
    ];
    const response = await postSigned(savedRecording);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.call as Record<string, unknown>).outcome).toBe("attached");
    expect(writes.some((write) => write.method === "POST")).toBe(false);
    expect(patchBody()).toMatchObject({
      transcriptionStatus: "PENDING",
      telnyxRecordingId: "rec-1",
    });
  });

  test("a transcript is stored and the row marked ready", async () => {
    existingRows = [{ id: "call-1", telnyxCallId: "cc-1" }];
    const response = await postSigned(savedTranscript);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.call as Record<string, unknown>).outcome).toBe("transcript-attached");
    expect(patchBody()).toMatchObject({ transcriptionStatus: "READY", transcript: "agent: how are you? prospect: fine." });
  });

  test("a transcription error marks the row failed", async () => {
    existingRows = [{ id: "call-1", telnyxCallId: "cc-1" }];
    const response = await postSigned(callEvent("call.recording.error", { call_control_id: "cc-1" }));
    const body = (await response.json()) as Record<string, unknown>;
    expect((body.call as Record<string, unknown>).outcome).toBe("marked-failed");
    expect(patchBody()).toEqual({ transcriptionStatus: "FAILED" });
  });

  test("a call event is not attributed to whichever operator signed in last", async () => {
    existingRows = [{ id: "call-1", telnyxCallId: "cc-1" }];
    await postSigned(savedTranscript);
    // A webhook is machine to machine. Crediting it to a person would be a lie
    // in the audit trail, so no createdBy rides along.
    expect(patchBody().createdBy).toBeUndefined();
  });

  test("an unsigned call event is refused before any Twenty write", async () => {
    const response = await postSigned(savedRecording, true);
    expect(response.status).toBe(401);
    expect(writes).toHaveLength(0);
  });

  test("no Twenty configured is a 503, not a silent drop", async () => {
    delete process.env.TWENTY_BASE_URL;
    const response = await postSigned(savedRecording);
    expect(response.status).toBe(503);
  });

  test("an unprovisioned agencyCalls object is a 503, so an operator can fix it", async () => {
    twentyStatus = 404;
    const response = await postSigned(savedRecording);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(body.error).toMatch(/not provisioned/i);
  });
});
