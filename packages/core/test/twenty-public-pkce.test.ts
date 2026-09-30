import { describe, expect, test, vi } from "vitest";
import { TwentyOAuthProvider } from "../src/twenty/oauth/helpers/provider.ts";
import { withBasicAuth } from "../src/twenty/oauth/helpers/basic-auth.ts";
import {
  base64UrlEncode,
  decodeJwtPayload,
  emailsFromClaims,
  registerClient,
} from "../src/twenty/oauth/helpers/oauth.ts";

/**
 * The public PKCE client, and why it is public.
 *
 * Two failures are pinned here, both of which present as "sign-in works but
 * nothing is ever attributed to a person":
 *
 *   1. registering as `client_secret_post` makes the client confidential, so the
 *      token endpoint authenticates the client rather than the user;
 *   2. presenting the auth-guard's basic credentials to `/oauth/token` makes
 *      Twenty answer with an APPLICATION_ACCESS token whose `sub` is the
 *      application id.
 *
 * The second is a deployment-shaped bug, so the test asserts on which fetch each
 * endpoint uses rather than on any message.
 */

/** A JWT with a real payload. The signature is not verified by design. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.not-a-real-signature`;
}

const DISCOVERY = {
  authorization_endpoint: "https://twenty.example/oauth/authorize",
  token_endpoint: "https://twenty.example/oauth/token",
  introspection_endpoint: "https://twenty.example/oauth/introspect",
  registration_endpoint: "https://twenty.example/oauth/register",
};

const CONFIG = {
  baseUrl: "https://twenty.example",
  clientId: "client-1",
  clientSecret: null,
  redirectUri: "http://localhost:5173/callback",
  scope: "api profile",
};

describe("registerClient", () => {
  test("registers a public client, so the token endpoint cannot authenticate the client", async () => {
    let body: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ client_id: "public-1" }));
    }) as unknown as typeof fetch;

    await registerClient(
      "https://twenty.example/oauth/register",
      { clientName: "Blaster", redirectUris: ["http://localhost:5173/callback"] },
      fetchFn,
    );

    // "none" is the whole fix. A confidential client here is what produces an
    // APPLICATION_ACCESS token with no human in it.
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.redirect_uris).toEqual(["http://localhost:5173/callback"]);
  });

  test("never returns a secret, even when the registration response offers one", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ client_id: "public-1", client_secret: "should-be-ignored" }),
      )) as unknown as typeof fetch;

    const registered = await registerClient(
      "https://twenty.example/oauth/register",
      { clientName: "Blaster", redirectUris: [] },
      fetchFn,
    );
    // Storing a secret that arrived anyway is how a deployment drifts back to
    // sending it, which is the failure this whole change exists to remove.
    expect(registered.clientSecret).toBeNull();
  });

  test("a registration with no client_id is an error, not a half-built client", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({}))) as unknown as typeof fetch;
    await expect(
      registerClient("https://twenty.example/oauth/register", { clientName: "B", redirectUris: [] }, fetchFn),
    ).rejects.toThrow(/client_id/);
  });
});

describe("decodeJwtPayload", () => {
  test("reads the claims that actually name a person", () => {
    const token = jwt({ sub: "app-42", userId: "u-1", userWorkspaceId: "m-1" });
    expect(decodeJwtPayload(token)).toMatchObject({
      sub: "app-42",
      userId: "u-1",
      userWorkspaceId: "m-1",
    });
  });

  test("handles base64url padding, which a token payload usually lacks", () => {
    // Lengths that do not divide by 3, so the encoder emits no "=" and the
    // decoder has to restore it.
    for (const payload of [{ a: 1 }, { ab: 2 }, { abc: 3 }, { abcd: 4 }, { abcde: 5 }]) {
      expect(decodeJwtPayload(jwt(payload))).toEqual(payload);
    }
  });

  test("a token that is not a JWT is an error, not an empty object", () => {
    expect(() => decodeJwtPayload("opaque-token")).toThrow(/not a JWT/);
    expect(() => decodeJwtPayload("only.two")).toThrow(/not a JWT/);
  });

  test("a payload that is not base64 is an error", () => {
    expect(() => decodeJwtPayload("a.!!!.c")).toThrow(/invalid JWT payload/);
  });

  test("a payload that is not JSON is an error", () => {
    const bad = base64UrlEncode(new TextEncoder().encode("not json"));
    expect(() => decodeJwtPayload(`a.${bad}.c`)).toThrow(/invalid JWT payload/);
  });
});

describe("emailsFromClaims", () => {
  test("takes any email-shaped claim, because the field name is not dependable", () => {
    expect(emailsFromClaims({ email: "a@x.com", someOtherField: "b@x.com" })).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  test("ignores non-emails and non-strings", () => {
    expect(
      emailsFromClaims({ scope: "api profile", count: 3, url: "https://x.com", mail: "a@x" }),
    ).toEqual([]);
  });

  test("trims and de-duplicates", () => {
    expect(emailsFromClaims({ a: " x@y.com ", b: "x@y.com" })).toEqual(["x@y.com"]);
  });

  test("tolerates nothing at all", () => {
    expect(emailsFromClaims(null)).toEqual([]);
    expect(emailsFromClaims(undefined)).toEqual([]);
  });
});

describe("the guard is not presented to the token endpoint", () => {
  const seen: Array<{ url: string; auth: string | null }> = [];
  const recorder = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    if (url.includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "at", token_type: "Bearer" }));
    }
    if (url.includes("/oauth/register")) {
      return new Response(JSON.stringify({ client_id: "public-1" }));
    }
    if (url.includes("/oauth/introspect")) {
      return new Response(JSON.stringify({ active: true, sub: "app-42" }));
    }
    return new Response(JSON.stringify(DISCOVERY), {
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const provider = () =>
    new TwentyOAuthProvider(CONFIG, {
      unguarded: recorder,
      guarded: withBasicAuth({ user: "twenty", password: "guard" }, recorder),
    });

  /** The calls where a guard credential is actively harmful. */
  const credentialFree = () =>
    seen.filter((call) => call.url.includes("/oauth/token") || call.url.includes("/oauth/register"));

  test("discovery and introspection carry the guard", async () => {
    seen.length = 0;
    await provider().endpoints();
    await provider().introspect("at");
    // Each provider() is a fresh instance, so discovery runs again before the
    // introspection call. Every one of them must be guarded.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((call) => call.auth?.startsWith("Basic "))).toBe(true);
  });

  test("the code exchange and the refresh carry no Authorization header at all", async () => {
    seen.length = 0;
    await provider().exchangeCode({ code: "c", verifier: "v" });
    await provider().refreshAccessToken("rt");

    // Both operations discover their endpoints first, and that discovery is
    // guarded. Only the token calls themselves must be bare.
    const tokenCalls = seen.filter((call) => call.url.includes("/oauth/token"));
    expect(tokenCalls).toHaveLength(2);
    for (const call of tokenCalls) {
      // The regression this exists to catch: Basic here makes Twenty
      // authenticate the client as a service and return an APPLICATION_ACCESS
      // token whose sub is the application id.
      expect(call.auth).toBeNull();
    }
  });

  test("dynamic registration carries no Authorization header either", async () => {
    seen.length = 0;
    await provider().registerClient({ clientName: "Blaster", redirectUris: [] });
    expect(credentialFree()).toHaveLength(1);
    expect(credentialFree()[0]?.auth).toBeNull();
  });

  test("a provider with no guarded fetch falls back to the unguarded one", async () => {
    // Documented as failing loudly against a real guard rather than silently
    // working, so the wiring cannot be forgotten.
    seen.length = 0;
    const onlyOne = new TwentyOAuthProvider(CONFIG, { unguarded: recorder });
    await onlyOne.endpoints();
    expect(seen[0]?.auth).toBeNull();
  });
});
