/**
 * `GET /api/agency-phones`, through the real Hono app.
 *
 * This is the selector the guided send consumes: the client picks an
 * `agencyPhoneId` and later calls re-resolve it, so the properties pinned
 * here are that the id is the Twenty record id, that only sendable rows are
 * listed, and that an unauthenticated caller learns nothing about the
 * workspace's numbers.
 *
 * Unsendable means: no number, no messaging profile (the send route 409s on
 * those), or an `available` status, which marks an unpurchased candidate.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const PHONE_RECORDS = [
  { id: "rec-us-1", phoneNumber: "+15557654321", messagingProfileId: "profile-us-1", countryCode: "US", status: "active" },
  { id: "rec-ie-1", phoneNumber: "+353871234567", messagingProfileId: "profile-ie-1" },
  // Registered as a number, but never assigned a messaging profile: offering
  // it would end in the send route's 409.
  { id: "rec-no-profile", phoneNumber: "+442079460958", messagingProfileId: null },
  // An unpurchased candidate, not a sender.
  { id: "rec-available", phoneNumber: "+15559876543", messagingProfileId: "profile-x", status: "available" },
  { id: "rec-empty", phoneNumber: "", messagingProfileId: "profile-x" },
];

vi.mock("@blaster/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@blaster/core")>();
  return {
    ...actual,
    listAgencyPhones: async () => PHONE_RECORDS,
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

const get = (token: string | null) =>
  app.fetch(
    new Request("http://localhost/api/agency-phones", {
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    }),
  );

let app: { fetch: (request: Request) => Promise<Response> };

beforeEach(async () => {
  introspectionActive = true;
  process.env.TWENTY_BASE_URL = "https://twenty.example";
  process.env.TWENTY_API_KEY = "twenty-key-for-tests";
  const module = await import("../src/index.ts");
  app = module.default as unknown as { fetch: (request: Request) => Promise<Response> };
});

describe("GET /api/agency-phones", () => {
  test("refuses an unauthenticated caller", async () => {
    const response = await get(null);
    expect(response.status).toBe(401);
  });

  test("refuses a token Twenty says is not live", async () => {
    introspectionActive = false;
    const response = await get("at-operator");
    expect(response.status).toBe(401);
  });

  test("lists only sendable rows, keyed by the Twenty record id", async () => {
    const response = await get("at-operator");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      count: number;
      phones: Array<{ agencyPhoneId: string; phoneNumber: string; label: string; countryCode: string | null }>;
    };
    expect(body.count).toBe(2);
    expect(body.phones).toEqual([
      {
        agencyPhoneId: "rec-us-1",
        phoneNumber: "+15557654321",
        label: "+15557654321 (US)",
        countryCode: "US",
      },
      {
        agencyPhoneId: "rec-ie-1",
        phoneNumber: "+353871234567",
        label: "+353871234567",
        countryCode: null,
      },
    ]);
  });

  test("an unconfigured Twenty reads as an empty list, not a 500", async () => {
    const baseUrl = process.env.TWENTY_BASE_URL;
    const apiKey = process.env.TWENTY_API_KEY;
    delete process.env.TWENTY_BASE_URL;
    delete process.env.TWENTY_API_KEY;
    try {
      const response = await get("at-operator");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ count: 0, phones: [] });
    } finally {
      if (baseUrl !== undefined) process.env.TWENTY_BASE_URL = baseUrl;
      if (apiKey !== undefined) process.env.TWENTY_API_KEY = apiKey;
    }
  });
});
