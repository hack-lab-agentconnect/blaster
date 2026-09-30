/**
 * `BlasterApiClient.listSendingNumbers`, the sender selector's read path.
 *
 * Uses an injected fetch, so there is nothing to mock: the assertions pin the
 * path, the bearer header, and the error classification the selector will
 * branch on. Response validation beyond the envelope stays with the server
 * and its route test.
 */

import { describe, expect, test } from "vitest";
import { BlasterApiError, createBlasterApiClient } from "../src/blaster/api/index.ts";

interface Seen {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (seen: Seen) => Response | Promise<Response>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler({ url: String(url), init: init ?? {} })) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const PHONES = [
  { agencyPhoneId: "rec-us-1", phoneNumber: "+15557654321", label: "+15557654321 (US)", countryCode: "US" },
  { agencyPhoneId: "rec-ie-1", phoneNumber: "+353871234567", label: "+353871234567", countryCode: null },
];

describe("listSendingNumbers", () => {
  test("GETs /api/agency-phones with the operator token and returns the list", async () => {
    const seen: { current: Seen | null } = { current: null };
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-operator",
      fetchFn: stubFetch((s) => {
        seen.current = s;
        return json({ count: PHONES.length, phones: PHONES });
      }),
    });
    await expect(client.listSendingNumbers()).resolves.toEqual(PHONES);
    expect(seen.current?.url).toBe("https://blaster.example/api/agency-phones");
    expect((seen.current?.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer at-operator");
  });

  test("a 401 classifies as unauthorized so the caller signs in again", async () => {
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-stale",
      fetchFn: stubFetch(() => json({ error: "Token is not active" }, 401)),
    });
    const error = await client.listSendingNumbers().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BlasterApiError);
    expect((error as BlasterApiError).kind).toBe("unauthorized");
  });

  test("a dead server classifies as unavailable, not as an empty list", async () => {
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-operator",
      fetchFn: stubFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    const error = await client.listSendingNumbers().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BlasterApiError);
    expect((error as BlasterApiError).kind).toBe("unavailable");
  });

  test("a 500 classifies as server", async () => {
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-operator",
      fetchFn: stubFetch(() => json({ error: "Failed to list sending numbers" }, 502)),
    });
    const error = await client.listSendingNumbers().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BlasterApiError);
    expect((error as BlasterApiError).kind).toBe("server");
  });
});

describe("prospect selection contract", () => {
  const clientFor = (handler: (seen: Seen) => Response) =>
    createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-operator",
      fetchFn: stubFetch(handler),
    });

  test("lists the filter menu with bearer auth", async () => {
    const seen: { current: Seen | null } = { current: null };
    const client = clientFor((s) => {
      seen.current = s;
      return json({ fields: [{ name: "niche", label: "Industry", type: "string", filterOperators: ["eq"], operatorLabels: ["equals"] }] });
    });
    await expect(client.listProspectFields()).resolves.toEqual([
      { name: "niche", label: "Industry", type: "string", filterOperators: ["eq"], operatorLabels: ["equals"] },
    ]);
    expect(seen.current?.url).toBe("https://blaster.example/api/prospects/fields");
  });

  test("search posts filter definitions, never query DSL", async () => {
    let body: unknown = null;
    const client = clientFor((s) => {
      body = JSON.parse((s.init.body as string) ?? "{}");
      return json({ total: 0, prospects: [], nextCursor: null });
    });
    const filters = [{ field: "niche", operator: "eq", value: "plumbing" }];
    await client.searchProspects({ filters, limit: 20 });
    expect(body).toEqual({ filters, limit: 20 });
  });

  test("preview posts the number id, filters, and text", async () => {
    const seen: { current: Seen | null } = { current: null };
    const client = clientFor((s) => {
      seen.current = s;
      return json({ total: 2, eligible: 1, skipped: 1, sample: [] });
    });
    const input = { agencyPhoneId: "rec-1", filters: [], text: "hi" };
    await expect(client.previewProspectSend(input)).resolves.toEqual({ total: 2, eligible: 1, skipped: 1, sample: [] });
    expect(seen.current?.url).toBe("https://blaster.example/api/messages/preview");
    expect(JSON.parse((seen.current?.init.body as string) ?? "{}")).toEqual(input);
  });

  test("batch send posts the idempotency key with the definitions", async () => {
    let body: unknown = null;
    const client = clientFor((s) => {
      body = JSON.parse((s.init.body as string) ?? "{}");
      return json({ agencyPhoneId: "rec-1", from: "+1", idempotencyKey: "k", total: 0, sent: 0, skipped: 0, failed: 0, outcomes: [] });
    });
    const input = { agencyPhoneId: "rec-1", filters: [], text: "hi", idempotencyKey: "key-1" };
    const result = await client.sendToProspects(input);
    expect(body).toEqual(input);
    expect(result.failed).toBe(0);
  });
});
