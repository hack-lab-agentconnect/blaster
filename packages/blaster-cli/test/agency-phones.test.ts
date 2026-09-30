/**
 * The sender selector's read path, from the CLI package's side of the boundary.
 *
 * The CLI must consume the shared `BlasterApiClient` contract rather than
 * reaching into Twenty itself: the stable `agencyPhoneId` it picks here is
 * what later server calls re-resolve, so this test pins that the CLI sends
 * the bearer token, asks the right path, and receives selectable ids — not
 * the Twenty rows underneath.
 */

import { describe, expect, test } from "vitest";
import { BlasterApiError, createBlasterApiClient } from "@blaster/core";

function stubFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => handler(String(url), init ?? {})) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("agency phone selection source", () => {
  test("lists sending numbers with stable ids over the authenticated contract", async () => {
    let path = "";
    let authorization = "";
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-operator",
      fetchFn: stubFetch((url, init) => {
        path = new URL(url).pathname;
        authorization = (init.headers as Record<string, string>)["Authorization"] ?? "";
        return json({
          count: 1,
          phones: [
            { agencyPhoneId: "rec-us-1", phoneNumber: "+15557654321", label: "+15557654321 (US)", countryCode: "US" },
          ],
        });
      }),
    });
    const phones = await client.listSendingNumbers();
    expect(path).toBe("/api/agency-phones");
    expect(authorization).toBe("Bearer at-operator");
    expect(phones).toEqual([
      { agencyPhoneId: "rec-us-1", phoneNumber: "+15557654321", label: "+15557654321 (US)", countryCode: "US" },
    ]);
  });

  test("a rejected token surfaces as unauthorized so the CLI signs in again", async () => {
    const client = createBlasterApiClient({
      baseUrl: "https://blaster.example",
      accessToken: "at-stale",
      fetchFn: stubFetch(() => json({ error: "Token is not active" }, 401)),
    });
    const error = await client.listSendingNumbers().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(BlasterApiError);
    expect((error as BlasterApiError).kind).toBe("unauthorized");
  });
});
