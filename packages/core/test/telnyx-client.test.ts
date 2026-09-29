import { afterEach, describe, expect, test, vi } from "vitest";
import {
  TelnyxError,
  listMessagingProfiles,
  officialClient,
  sendMessage,
  sendStatusOf,
  toTelnyxError,
} from "../src/telnyx/messaging/helpers/client.ts";

describe("toTelnyxError", () => {
  test("passes TelnyxError through untouched", () => {
    const original = new TelnyxError(422, "nope");
    expect(toTelnyxError(original)).toBe(original);
  });

  test("maps SDK status errors, truncating the detail", () => {
    const sdkError = Object.assign(new Error("x".repeat(500)), { status: 401 });
    const mapped = toTelnyxError(sdkError);
    expect(mapped).toBeInstanceOf(TelnyxError);
    expect(mapped.status).toBe(401);
    expect(mapped.message.length).toBeLessThanOrEqual("Telnyx 401: ".length + 300);
  });

  test("status-less failures become 500s", () => {
    const mapped = toTelnyxError(new Error("socket hang up"));
    expect(mapped.status).toBe(500);
    expect(mapped.message).toContain("socket hang up");
  });

  test("non-errors become 500s without throwing on access", () => {
    expect(toTelnyxError("plain string").status).toBe(500);
    expect(toTelnyxError(null).status).toBe(500);
  });
});

describe("officialClient", () => {
  test("memoises per api key", () => {
    expect(officialClient("key-a")).toBe(officialClient("key-a"));
    expect(officialClient("key-a")).not.toBe(officialClient("key-b"));
  });
});

/** Stub global fetch so SDK paths run with canned Telnyx payloads, no network. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init ?? {}));
  vi.stubGlobal("fetch", spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendMessage", () => {
  test("rejects clientReference loudly instead of dropping it", async () => {
    await expect(
      sendMessage({
        apiKey: "key",
        from: "+15557654321",
        to: "+15551234567",
        text: "hi",
        messagingProfileId: null,
        clientReference: "ref-1",
      }),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 400 });
  });

  test("sends through the SDK and normalises the response", async () => {
    // The real payload, captured from a live send: the state is per recipient at
    // to[n].status, and there is no top-level status to read.
    const spy = stubFetch((_url, _init) =>
      jsonResponse({
        data: {
          id: "msg-1",
          record_type: "message",
          direction: "outbound",
          from: { phone_number: "+15557654321", carrier: "TELNYX" },
          to: [{ phone_number: "+15551234567", status: "delivered", carrier: "BOOST" }],
          sent_at: "2026-09-29T17:06:47.148+00:00",
        },
      }),
    );
    const sent = await sendMessage({
      apiKey: "stubbed-key-send",
      from: "+15557654321",
      to: "+15551234567",
      text: "hi",
      messagingProfileId: "profile-1",
    });
    expect(sent).toEqual({
      id: "msg-1",
      status: "delivered",
      from: "+15557654321",
      to: "+15551234567",
      profileId: "profile-1",
    });
    const [calledUrl, calledInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://api.telnyx.com/v2/messages");
    // The SDK passes a Headers instance, not a plain record.
    const sentHeaders = new Headers(calledInit.headers);
    expect(sentHeaders.get("Authorization")).toBe("Bearer stubbed-key-send");
    expect(JSON.parse(String(calledInit.body))).toEqual({
      from: "+15557654321",
      to: "+15551234567",
      text: "hi",
      messaging_profile_id: "profile-1",
    });
  });

  test("SDK failures surface as TelnyxError with status", async () => {
    stubFetch(() => jsonResponse({ errors: [{ detail: "bad key" }] }, 401));
    await expect(
      sendMessage({
        apiKey: "stubbed-key-fail",
        from: "+15557654321",
        to: "+15551234567",
        text: "hi",
        messagingProfileId: null,
      }),
    ).rejects.toMatchObject({ name: "TelnyxError", status: 401 });
  });
});

describe("listMessagingProfiles", () => {
  test("reads profiles through the SDK", async () => {
    stubFetch(() =>
      jsonResponse({
        data: [
          {
            id: "profile-1",
            name: "main",
            whitelisted_destinations: ["US"],
            alpha_sender: null,
          },
        ],
        meta: { page_number: 1, total_pages: 1 },
      }),
    );
    await expect(listMessagingProfiles("stubbed-key-profiles")).resolves.toEqual([
      {
        id: "profile-1",
        name: "main",
        whitelistedDestinations: ["US"],
        alphaSender: null,
      },
    ]);
  });
});

/**
 * Where the delivery state of a send actually lives.
 *
 * Every send used to report "unknown" while Telnyx knew the answer, because the
 * status was being read from the top of the message instead of from the
 * recipient it applies to. These cases pin the real shape, including the
 * top-level field that does not exist, so a future SDK change cannot quietly
 * take delivery tracking back to "unknown".
 */
describe("sendStatusOf", () => {
  test("reads the status the carrier reported for the recipient", () => {
    expect(
      sendStatusOf({ to: [{ phone_number: "+15551234567", status: "delivered", carrier: "BOOST" }] }),
    ).toBe("delivered");
  });

  test("reads a pre-delivery state too", () => {
    expect(sendStatusOf({ to: [{ phone_number: "+15551234567", status: "queued" }] })).toBe("queued");
    expect(sendStatusOf({ to: [{ status: "sent" }] })).toBe("sent");
  });

  test("ignores a top-level status, because Telnyx does not send one", () => {
    // A test that fed this shape is what let the bug through: it looked right,
    // so nothing questioned why every live send said "unknown".
    expect(sendStatusOf({ status: "delivered", to: [{ status: "failed" }] })).toBe("failed");
    expect(sendStatusOf({ status: "delivered" })).toBe("unknown");
  });

  test("a message with no recipient state is unknown, not a guess", () => {
    expect(sendStatusOf({})).toBe("unknown");
    expect(sendStatusOf({ to: [] })).toBe("unknown");
    expect(sendStatusOf({ to: [{ phone_number: "+15551234567" }] })).toBe("unknown");
  });

  test("skips malformed entries rather than returning junk", () => {
    expect(sendStatusOf({ to: [null, "nonsense", { status: 7 }, { status: "delivered" }] })).toBe(
      "delivered",
    );
  });

  test("the first recipient that reports a state decides the send", () => {
    // Blaster sends to one number, so this is the send's status. A fan-out
    // would need per-recipient reporting, and pretending otherwise would report
    // one recipient's outcome as the whole message's.
    expect(
      sendStatusOf({ to: [{ status: "queued" }, { status: "delivered" }, { status: "failed" }] }),
    ).toBe("queued");
  });
});
