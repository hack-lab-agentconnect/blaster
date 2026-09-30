import { describe, expect, test, vi } from "vitest";
import {
  base64UrlEncode,
  buildAuthorizeUrl,
  codeChallengeForVerifier,
  generateCodeVerifier,
  generateState,
  isTokenExpired,
} from "../src/twenty/oauth/helpers/oauth.ts";
import { TwentyOAuthProvider } from "../src/twenty/oauth/helpers/provider.ts";

function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  return vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const key = `${String(init?.method ?? "GET")} ${String(url)}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch: ${key}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    } as Response;
  });
}

const DISCOVERY = {
  authorization_endpoint: "https://twenty.example/oauth/authorize",
  token_endpoint: "https://twenty.example/oauth/token",
  registration_endpoint: "https://twenty.example/oauth/register",
  introspection_endpoint: "https://twenty.example/oauth/introspect",
  revocation_endpoint: "https://twenty.example/oauth/revoke",
};

function providerWith(fetchFn: ReturnType<typeof stubFetch>) {
  return new TwentyOAuthProvider(
    {
      baseUrl: "https://twenty.example",
      clientId: "client-1",
      clientSecret: "secret-1",
      redirectUri: "https://app.example/callback",
      scope: "api profile",
    },
    { unguarded: fetchFn as unknown as typeof fetch },
  );
}

describe("pkce primitives", () => {
  test("base64url encodes without padding or plus/slash", () => {
    expect(base64UrlEncode(new Uint8Array([104, 105]))).toBe("aGk");
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
  });

  test("rfc 7636 s256 test vector", async () => {
    // Appendix B verifier. Verified against node:crypto and Buffer
    // base64url independently: both agree on this 43-char value.
    await expect(
      codeChallengeForVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("verifier and state lengths", () => {
    expect(generateCodeVerifier()).toHaveLength(43);
    expect(generateState()).toHaveLength(22);
  });

  test("authorize url carries pkce params", () => {
    const url = buildAuthorizeUrl({
      authorizationEndpoint: DISCOVERY.authorization_endpoint,
      clientId: "client-1",
      redirectUri: "https://app.example/callback",
      scope: "api profile",
      state: "st",
      challenge: "ch",
    });
    expect(url).toContain("response_type=code");
    expect(url).toContain("code_challenge=ch");
    expect(url).toContain("code_challenge_method=S256");
  });
});

describe("TwentyOAuthProvider", () => {
  test("full code flow against stubbed twenty", async () => {
    const fetchFn = stubFetch({
      "GET https://twenty.example/.well-known/oauth-authorization-server": { body: DISCOVERY },
      "POST https://twenty.example/oauth/token": {
        body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "api profile" },
      },
      "POST https://twenty.example/oauth/introspect": {
        body: { active: true, username: "op@example.com", scope: "api profile" },
      },
    });
    const provider = providerWith(fetchFn);

    const authorize = await provider.authorizeUrl({ state: "st", challenge: "ch" });
    expect(authorize).toContain("client_id=client-1");

    const tokens = await provider.exchangeCode({ code: "code-1", verifier: "ver-1" });
    expect(tokens.accessToken).toBe("at-1");
    expect(tokens.refreshToken).toBe("rt-1");

    // The code exchange posts the verifier and secret in the body, never the url.
    const tokenCall = fetchFn.mock.calls.find(([url]) => String(url).includes("/oauth/token"));
    expect(String(tokenCall?.[1]?.body)).toContain("code_verifier=ver-1");
    expect(String(tokenCall?.[1]?.body)).toContain("client_secret=secret-1");
    expect(String(tokenCall?.[0])).not.toContain("verifier");

    const introspection = await provider.introspect("at-1");
    expect(introspection.active).toBe(true);
    expect(introspection.username).toBe("op@example.com");

    // Discovery is cached: one GET for authorize + exchange + introspect.
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes(".well-known")).length).toBe(1);
  });

  test("refresh rotates tokens", async () => {
    const fetchFn = stubFetch({
      "GET https://twenty.example/.well-known/oauth-authorization-server": { body: DISCOVERY },
      "POST https://twenty.example/oauth/token": {
        body: { access_token: "at-2", refresh_token: "rt-2", expires_in: 3600 },
      },
    });
    const tokens = await providerWith(fetchFn).refreshAccessToken("rt-1");
    expect(tokens.accessToken).toBe("at-2");
  });

  test("public instance omits the secret", async () => {
    const fetchFn = stubFetch({
      "GET https://twenty.example/.well-known/oauth-authorization-server": { body: DISCOVERY },
      "POST https://twenty.example/oauth/token": { body: { access_token: "at-3" } },
    });
    const provider = new TwentyOAuthProvider(
      {
        baseUrl: "https://twenty.example",
        clientId: "client-1",
        clientSecret: null,
        redirectUri: "https://app.example/callback",
        scope: "api",
      },
      { unguarded: fetchFn as unknown as typeof fetch },
    );
    await provider.exchangeCode({ code: "code-1", verifier: "ver-1" });
    const tokenCall = fetchFn.mock.calls.find(([url]) => String(url).includes("/oauth/token"));
    expect(String(tokenCall?.[1]?.body)).not.toContain("client_secret");
  });

  test("register throws without a registration endpoint", async () => {
    const fetchFn = stubFetch({
      "GET https://twenty.example/.well-known/oauth-authorization-server": {
        body: { ...DISCOVERY, registration_endpoint: undefined },
      },
    });
    await expect(
      providerWith(fetchFn).registerClient({ clientName: "x", redirectUris: ["https://app.example/callback"] }),
    ).rejects.toThrow("no registration endpoint");
  });
});

describe("isTokenExpired", () => {
  test("60s skew and null expiry", () => {
    expect(isTokenExpired(1_000, 3_600, 1_000 + 3_600_000 - 61_000)).toBe(false);
    expect(isTokenExpired(1_000, 3_600, 1_000 + 3_600_000 - 59_000)).toBe(true);
    expect(isTokenExpired(1_000, null, 999_999_999)).toBe(false);
  });
});
