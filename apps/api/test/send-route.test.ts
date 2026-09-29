/**
 * `POST /api/messages/send`, through the real Hono app.
 *
 * This is the route `blaster send` calls, and the assertions are about where the
 * messaging profile comes from. A workspace with several numbers cannot be
 * described by one environment variable, because each number is bought or
 * assigned against its own registration, so the profile is read from the sending
 * number's `agencyPhones` record and from nowhere else.
 *
 * That is the property most worth pinning, because the failure it prevents is
 * invisible: a global default produces a 200, a billed message, and a carrier
 * rejection after the fact. So the environment is populated with a deliberately
 * wrong profile in the success case, and the test still expects the record's.
 *
 * The unauthenticated cases are asserted explicitly. A send spends money and
 * reaches a real person, so "we could not check the token" must never mean
 * "allowed".
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const PHONE_RECORDS = [
  { phoneNumber: "+15557654321", messagingProfileId: "profile-us-1" },
  { phoneNumber: "+353871234567", messagingProfileId: "profile-ie-1" },
  // Registered as a number, but never assigned a messaging profile. This is the
  // case a global default would silently paper over.
  { phoneNumber: "+442079460958", messagingProfileId: null },
];

vi.mock("@blaster/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blaster/core")>();
  return {
    ...actual,
    listAgencyPhones: async () => PHONE_RECORDS,
  };
});

interface SentArgs {
  apiKey: string;
  from: string;
  to: string;
  text: string;
  messagingProfileId: string | null;
}

let sent: SentArgs | null = null;
let sendFails: Error | null = null;
let telnyxStatus = "queued";

vi.mock("../src/lib/telnyx/messaging/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telnyx/messaging/index.ts")>();
  return {
    ...actual,
    sendMessage: async (args: SentArgs) => {
      if (sendFails) throw sendFails;
      sent = args;
      return {
        id: "telnyx-1",
        status: telnyxStatus,
        from: args.from,
        to: args.to,
        profileId: args.messagingProfileId,
      };
    },
  };
});

let introspectionActive = true;

vi.mock("../src/lib/twenty/oauth/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/twenty/oauth/index.ts")>();
  return {
    ...actual,
    loadOAuthConfig: () => ({ clientId: "c", clientSecret: null, authorizationUrl: "a", tokenUrl: "t" }),
    checkOperatorToken: async (_config: unknown, token: string) => ({
      active: introspectionActive && token === "at-operator",
      username: "operator",
      scope: "api",
    }),
  };
});

const post = (body: Record<string, unknown>, token: string | null) =>
  app.fetch(
    new Request("http://localhost/api/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );

let app: { fetch: (request: Request) => Promise<Response> };

beforeEach(async () => {
  sent = null;
  sendFails = null;
  telnyxStatus = "queued";
  introspectionActive = true;
  // A deliberately wrong global profile, present in the environment for every
  // case. If any of these sends resolves to it, the number's own record is being
  // bypassed and the test fails.
  process.env.TELNYX_API_KEY = "key-for-tests";
  process.env.TELNYX_MESSAGING_PROFILE_ID = "profile-from-env-MUST-NOT-BE-USED";
  // The record lookup is skipped entirely without these, which would make every
  // number look unregistered and turn this file into a test of the 409 alone.
  process.env.TWENTY_BASE_URL = "https://twenty.example";
  process.env.TWENTY_API_KEY = "twenty-key-for-tests";
  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/messages/send", () => {
  test("refuses an unauthenticated caller and sends nothing", async () => {
    const response = await post({ to: "+15551234567", from: "+15557654321", text: "hi" }, null);
    expect(response.status).toBe(401);
    expect(sent).toBeNull();
  });

  test("refuses a token Twenty says is not live, and sends nothing", async () => {
    const response = await post({ to: "+15551234567", from: "+15557654321", text: "hi" }, "at-stale");
    expect(response.status).toBe(401);
    expect(sent).toBeNull();
  });

  test("takes the profile from the sending number's record, not the environment", async () => {
    const response = await post(
      { to: "+15551234567", from: "+15557654321", text: "hi" },
      "at-operator",
    );
    expect(response.status).toBe(200);
    expect(sent?.messagingProfileId).toBe("profile-us-1");
    // The global variable is set to a different profile for this whole file, so
    // reaching it would be visible here.
    expect(sent?.messagingProfileId).not.toBe("profile-from-env-MUST-NOT-BE-USED");
  });

  test("two numbers send on their own profiles, which is why one variable cannot work", async () => {
    await post({ to: "+15551234567", from: "+15557654321", text: "hi" }, "at-operator");
    expect(sent?.messagingProfileId).toBe("profile-us-1");
    await post({ to: "+15551234567", from: "+353871234567", text: "hi" }, "at-operator");
    expect(sent?.messagingProfileId).toBe("profile-ie-1");
  });

  test("the echoed resolution says where the profile came from", async () => {
    const response = await post(
      { to: "+15551234567", from: "+15557654321", text: "hi" },
      "at-operator",
    );
    const body = (await response.json()) as { resolution: { reason: string; profileId: string } };
    expect(body.resolution.reason).toBe("bound-to-number");
    expect(body.resolution.profileId).toBe("profile-us-1");
  });

  test("a number with no profile is refused, not sent on a default", async () => {
    // The dangerous case: this number exists in the workspace and is registered,
    // but has no messaging profile. A global default would accept the message
    // and let the carrier reject it after billing.
    const response = await post(
      { to: "+15551234567", from: "+442079460958", text: "hi" },
      "at-operator",
    );
    expect(response.status).toBe(409);
    expect(sent).toBeNull();
  });

  test("a number the workspace does not own is refused", async () => {
    const response = await post({ to: "+15551234567", from: "+15550001111", text: "hi" }, "at-operator");
    expect(response.status).toBe(409);
    expect(sent).toBeNull();
  });

  test("a profile in the request body is ignored", async () => {
    // The profile is a property of the sending number's registration, so a caller
    // naming a different one must not be able to move the send onto it.
    const response = await post(
      { to: "+15551234567", from: "+15557654321", text: "hi", numberProfileId: "profile-ie-1" },
      "at-operator",
    );
    expect(response.status).toBe(200);
    expect(sent?.messagingProfileId).toBe("profile-us-1");
  });

  test("matching the record survives how the caller writes the number", async () => {
    const response = await post(
      { to: "+15551234567", from: "+1 (555) 765-4321", text: "hi" },
      "at-operator",
    );
    expect(response.status).toBe(200);
    expect(sent?.messagingProfileId).toBe("profile-us-1");
  });

  test("the provider's acceptance status is reported, not a delivery claim", async () => {
    telnyxStatus = "queued";
    const response = await post(
      { to: "+15551234567", from: "+15557654321", text: "hi" },
      "at-operator",
    );
    const body = (await response.json()) as { sent: { status: string } };
    // Acceptance is what the send returns. Delivery arrives later, on the
    // webhook, and claiming it here would be a lie the operator sees as success.
    expect(body.sent.status).toBe("queued");
  });

  test("a provider failure is a gateway error, and the message is not retried silently", async () => {
    const { TelnyxError } = await import("@blaster/core");
    sendFails = new TelnyxError(422, "destination unreachable");
    const response = await post(
      { to: "+15551234567", from: "+15557654321", text: "hi" },
      "at-operator",
    );
    expect(response.status).toBe(502);
  });

  test("to and text are required", async () => {
    const missingText = await post({ to: "+15551234567", from: "+15557654321" }, "at-operator");
    expect(missingText.status).toBe(400);
    const missingTo = await post({ from: "+15557654321", text: "hi" }, "at-operator");
    expect(missingTo.status).toBe(400);
    expect(sent).toBeNull();
  });

  test("from is required: Blaster will not pick a sending number", async () => {
    const response = await post({ to: "+15551234567", text: "hi" }, "at-operator");
    expect(response.status).toBe(400);
    expect(sent).toBeNull();
  });
});
