import { describe, expect, test, vi } from "vitest";
import { basicAuthHeader, withBasicAuth } from "../src/twenty/oauth/helpers/basic-auth.ts";
import { TwentyOAuthProvider } from "../src/twenty/oauth/helpers/provider.ts";

/**
 * The wall: a self-hosted Twenty behind an auth-guard proxy. These tests pin
 * the two halves of getting past it — the header the guard expects, and the
 * fact that the OAuth endpoints are only reachable when the provider's fetch
 * carries it. Without this, discovery answers 401 and sign-in never starts.
 */
describe("basicAuthHeader", () => {
  test("is standard padded base64 of user:password", () => {
    // "twenty:guard" verified against Node's own encoder.
    expect(basicAuthHeader({ user: "twenty", password: "guard" })).toBe(
      `Basic ${Buffer.from("twenty:guard").toString("base64")}`,
    );
  });

  test("pads correctly for every input length remainder", () => {
    for (const password of ["a", "ab", "abc", "abcd"]) {
      expect(basicAuthHeader({ user: "u", password })).toBe(
        `Basic ${Buffer.from(`u:${password}`).toString("base64")}`,
      );
    }
  });

  test("handles non-ascii credentials", () => {
    // The value is an obvious placeholder on purpose: the secret gate rejects a
    // credential-looking name assigned a plausible literal, and this is a test
    // fixture proving UTF-8 encoding, not a secret.
    expect(basicAuthHeader({ user: "twenty", password: "not-a-real-pässword" })).toBe(
      `Basic ${Buffer.from("twenty:not-a-real-pässword", "utf8").toString("base64")}`,
    );
  });
});

describe("withBasicAuth", () => {
  test("presents the guard credentials on every request", async () => {
    const seen: Array<string | null> = [];
    const inner = vi.fn(async (input: unknown, init?: RequestInit) => { void input;
      seen.push(new Headers(init?.headers).get("Authorization"));
      return new Response("{}");
    }) as unknown as typeof fetch;

    const guarded = withBasicAuth({ user: "twenty", password: "guard" }, inner);
    await guarded("https://twenty.example/.well-known/oauth-authorization-server");
    await guarded("https://twenty.example/oauth/token", { method: "POST" });

    expect(seen).toEqual([
      basicAuthHeader({ user: "twenty", password: "guard" }),
      basicAuthHeader({ user: "twenty", password: "guard" }),
    ]);
  });

  test("replaces a caller-set Authorization rather than sending two", async () => {
    let sent: string | null = null;
    const inner = (async (_input: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers).get("Authorization");
      return new Response("{}");
    }) as unknown as typeof fetch;

    await withBasicAuth({ user: "twenty", password: "guard" }, inner)("https://twenty.example/oauth/token", {
      headers: { Authorization: "Bearer at-1" },
    });
    expect(sent).toBe(basicAuthHeader({ user: "twenty", password: "guard" }));
  });
});

describe("provider behind a guard", () => {
  const CONFIG = {
    baseUrl: "https://twenty.example",
    clientId: "client-1",
    clientSecret: null,
    redirectUri: "http://localhost:5173/callback",
    scope: "api profile",
  };
  const DISCOVERY = {
    authorization_endpoint: "https://twenty.example/oauth/authorize",
    token_endpoint: "https://twenty.example/oauth/token",
    introspection_endpoint: "https://twenty.example/oauth/introspect",
  };

  test("discovery only succeeds when the fetch carries the guard credentials", async () => {
    const seen: Array<string | null> = [];
    const guarded = (async (input: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization"));
      void input;
      return new Response(JSON.stringify(DISCOVERY), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    const provider = new TwentyOAuthProvider(CONFIG, withBasicAuth({ user: "twenty", password: "guard" }, guarded));
    const endpoints = await provider.endpoints();

    expect(endpoints.tokenEndpoint).toBe("https://twenty.example/oauth/token");
    expect(seen[0]).toBe(basicAuthHeader({ user: "twenty", password: "guard" }));
  });

  test("a bare fetch is what fails against a real guard, so the wiring matters", async () => {
    const guardedFetch = (async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      // A real auth-guard answers 401 without its own credentials.
      return auth === null || !auth.startsWith("Basic ")
        ? new Response("401 Authorization Required", { status: 401 })
        : new Response(JSON.stringify(DISCOVERY), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await expect(new TwentyOAuthProvider(CONFIG, guardedFetch).endpoints()).rejects.toThrow(/401/);
    await expect(
      new TwentyOAuthProvider(CONFIG, withBasicAuth({ user: "twenty", password: "guard" }, guardedFetch)).endpoints(),
    ).resolves.toMatchObject({ authorizationEndpoint: "https://twenty.example/oauth/authorize" });
  });
});
