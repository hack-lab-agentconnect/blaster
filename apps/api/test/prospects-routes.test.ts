/**
 * Prospect selection and batch send, through the real Hono app.
 *
 * The properties pinned here are the contract boundaries: filters arrive as
 * definitions and are validated against the menu (never raw DSL), the sending
 * number arrives as an id the server re-resolves (never a number or profile
 * of the caller's choosing), preview never sends, and a batch accounts for
 * every recipient instead of faking one success.
 *
 * Twenty and Telnyx are stubbed at the module seams; the menu, validation,
 * DSL rendering, profile resolution, and eligibility rules are the real
 * shared implementations, because those are exactly what must not drift.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const PHONE_ROWS = [
  { id: "rec-us-1", phoneNumber: "+15557654321", messagingProfileId: "profile-us-1" },
  { id: "rec-no-profile", phoneNumber: "+442079460958", messagingProfileId: null },
];

let markCalls: Array<{ id: string; state: string }> = [];

vi.mock("@blaster/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blaster/core")>();
  return {
    ...actual,
    listAgencyPhones: async () => PHONE_ROWS,
    searchProspectsPage: async () => ({
      summaries: [
        { id: "p-1", name: "Acme", phone: "+15550001111", country: "US", campaign: null },
        { id: "p-2", name: "Beta", phone: "+15550002222", country: "US", campaign: null },
      ],
      nextCursor: null,
      total: 2,
    }),
    walkProspectRows: async () => [
      { id: "p-1", name: "Acme", phone: "+15550001111", country: "US" },
      { id: "p-2", name: "Beta", phone: null, country: "US" },
      { id: "p-3", name: "Gamma", phone: "+15550003333", country: "US", outboundState: "OPTED_OUT" },
    ],
    markProspectOutbound: async (client: unknown, id: string, state: string) => {
      markCalls.push({ id, state });
    },
  };
});

interface SentArgs {
  apiKey: string;
  from: string;
  to: string;
  text: string;
  messagingProfileId: string | null;
}

let sent: SentArgs[] = [];
let sendFailsFor: string | null = null;

vi.mock("../src/lib/telnyx/messaging/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telnyx/messaging/index.ts")>();
  return {
    ...actual,
    sendMessage: async (args: SentArgs) => {
      if (sendFailsFor === args.to) throw new Error("carrier rejected");
      sent.push(args);
      return { id: `telnyx-${args.to}`, status: "queued", from: args.from, to: args.to, profileId: args.messagingProfileId };
    },
  };
});

vi.mock("../src/lib/twenty/oauth/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/twenty/oauth/index.ts")>();
  return {
    ...actual,
    loadOAuthConfig: () => ({ clientId: "c", clientSecret: null, authorizationUrl: "a", tokenUrl: "t" }),
    checkOperatorToken: async (_config: unknown, token: string) => ({
      active: token === "at-operator",
      username: "operator",
      scope: "api",
    }),
  };
});

const call = (method: string, path: string, body: unknown, token: string | null) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

let app: { fetch: (request: Request) => Promise<Response> };

beforeEach(async () => {
  sent = [];
  sendFailsFor = null;
  markCalls = [];
  process.env.TELNYX_API_KEY = "key-for-tests";
  process.env.TWENTY_BASE_URL = "https://twenty.example";
  process.env.TWENTY_API_KEY = "twenty-key-for-tests";
  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

describe("GET /api/prospects/fields", () => {  test("refuses an unauthenticated caller", async () => {
    expect((await call("GET", "/api/prospects/fields", undefined, null)).status).toBe(401);
  });

  test("returns the filter menu grounded in the Twenty schema", async () => {
    const response = await call("GET", "/api/prospects/fields", undefined, "at-operator");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { fields: Array<{ name: string; filterOperators: string[] }> };
    const names = body.fields.map((field) => field.name);
    expect(names).toContain("niche");
    expect(names).toContain("phone");
    expect(body.fields.every((field) => field.filterOperators.length > 0)).toBe(true);
  });
});

describe("POST /api/prospects/search", () => {
  test("rejects unknown fields and operators without touching Twenty", async () => {
    const badField = await call(
      "POST",
      "/api/prospects/search",
      { filters: [{ field: "nope", operator: "eq", value: "x" }] },
      "at-operator",
    );
    expect(badField.status).toBe(400);
    const badOp = await call(
      "POST",
      "/api/prospects/search",
      { filters: [{ field: "rating", operator: "like", value: "4" }] },
      "at-operator",
    );
    expect(badOp.status).toBe(400);
  });

  test("returns the page the shared search builds", async () => {
    const response = await call(
      "POST",
      "/api/prospects/search",
      { filters: [{ field: "niche", operator: "eq", value: "plumbing" }] },
      "at-operator",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; prospects: unknown[]; nextCursor: null };
    expect(body.total).toBe(2);
    expect(body.prospects).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
  });
});

describe("POST /api/messages/preview", () => {
  test("counts eligibility without sending anything", async () => {
    const response = await call(
      "POST",
      "/api/messages/preview",
      { agencyPhoneId: "rec-us-1", filters: [], text: "hi" },
      "at-operator",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      total: 3,
      eligible: 1,
      skipped: 2,
      sample: [{ id: "p-1", name: "Acme", phone: "+15550001111", country: "US", campaign: null }],
    });
    expect(sent).toHaveLength(0);
  });

  test("rejects an unknown sending number and a missing text", async () => {
    const unknown = await call(
      "POST",
      "/api/messages/preview",
      { agencyPhoneId: "rec-missing", filters: [], text: "hi" },
      "at-operator",
    );
    expect(unknown.status).toBe(404);
    const noText = await call("POST", "/api/messages/preview", { agencyPhoneId: "rec-us-1", filters: [] }, "at-operator");
    expect(noText.status).toBe(400);
  });
});

describe("POST /api/messages/batch-send", () => {
  const batch = (body: unknown, token: string | null = "at-operator") =>
    call("POST", "/api/messages/batch-send", body, token);

  test("requires auth, the number id, text, and an idempotency key", async () => {
    expect((await batch({ agencyPhoneId: "rec-us-1", filters: [], text: "hi", idempotencyKey: "k" }, null)).status).toBe(
      401,
    );
    expect(
      (await batch({ agencyPhoneId: "rec-us-1", filters: [], text: "hi" })).status,
    ).toBe(400);
    expect(
      (await batch({ agencyPhoneId: "rec-missing", filters: [], text: "hi", idempotencyKey: "k" })).status,
    ).toBe(404);
    expect(
      (await batch({ agencyPhoneId: "rec-no-profile", filters: [], text: "hi", idempotencyKey: "k" })).status,
    ).toBe(409);
  });

  test("sends per recipient, skips the ineligible, and reports every outcome", async () => {
    const response = await batch({ agencyPhoneId: "rec-us-1", filters: [], text: "hi", idempotencyKey: "key-1" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agencyPhoneId: string;
      from: string;
      idempotencyKey: string;
      total: number;
      sent: number;
      skipped: number;
      failed: number;
      outcomes: Array<{ prospectId: string; status: string; telnyxId?: string; detail?: string }>;
    };
    expect(body).toMatchObject({
      agencyPhoneId: "rec-us-1",
      from: "+15557654321",
      idempotencyKey: "key-1",
      total: 3,
      sent: 1,
      skipped: 2,
      failed: 0,
    });
    expect(body.outcomes.find((outcome) => outcome.prospectId === "p-1")).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "+15550001111", from: "+15557654321", messagingProfileId: "profile-us-1" });
    expect(markCalls).toContainEqual({ id: "p-1", state: "SENDING" });
    expect(markCalls).toContainEqual({ id: "p-1", state: "AWAITING_DELIVERY" });
  });

  test("a provider failure fails that recipient and marks it, without stopping the batch", async () => {
    sendFailsFor = "+15550001111";
    const response = await batch({ agencyPhoneId: "rec-us-1", filters: [], text: "hi", idempotencyKey: "key-2" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sent: number; failed: number; outcomes: Array<{ status: string; detail?: string }> };
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.outcomes.find((outcome) => outcome.status === "failed")?.detail).toContain("carrier rejected");
    expect(markCalls).toContainEqual({ id: "p-1", state: "FAILED" });
  });
});
