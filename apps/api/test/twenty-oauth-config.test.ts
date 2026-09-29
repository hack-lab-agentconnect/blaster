import { describe, expect, test, vi } from "vitest";
import { basicAuthHeader } from "@blaster/core";
import { loadOAuthConfig } from "../src/lib/twenty/oauth/helpers/config.ts";
import { twentyProvider } from "../src/lib/twenty/oauth/client.ts";

/**
 * The API is where the wall is actually dealt with: it is the only surface
 * that talks to Twenty's OAuth endpoints, and those sit behind an auth-guard
 * that answers 401 without basic credentials. These tests pin the wiring from
 * environment variables to the header on the wire.
 */
const FULL = {
  TWENTY_BASE_URL: "https://twenty.example",
  TWENTY_OAUTH_CLIENT_ID: "client-1",
  TWENTY_OAUTH_CLIENT_SECRET: "",
  TWENTY_OAUTH_REDIRECT_URI: "http://localhost:5173/callback",
};

const DISCOVERY = {
  authorization_endpoint: "https://twenty.example/oauth/authorize",
  token_endpoint: "https://twenty.example/oauth/token",
  introspection_endpoint: "https://twenty.example/oauth/introspect",
};

describe("loadOAuthConfig", () => {
  test("is null until the three required variables are present", () => {
    expect(loadOAuthConfig({})).toBeNull();
    expect(loadOAuthConfig({ ...FULL, TWENTY_OAUTH_CLIENT_ID: "" })).toBeNull();
    expect(loadOAuthConfig({ ...FULL, TWENTY_OAUTH_REDIRECT_URI: "" })).toBeNull();
    expect(loadOAuthConfig({ TWENTY_BASE_URL: "https://twenty.example" })).toBeNull();
  });

  test("defaults the scope and treats an empty secret as a public client", () => {
    const config = loadOAuthConfig(FULL as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ scope: "api profile", clientSecret: null });
  });

  test("a guard needs both halves; one alone means no guard", () => {
    expect(
      loadOAuthConfig({ ...FULL, TWENTY_BASIC_USER: "twenty" } as NodeJS.ProcessEnv)?.basicAuth,
    ).toBeNull();
    expect(
      loadOAuthConfig({ ...FULL, TWENTY_BASIC_PASSWORD: "guard" } as NodeJS.ProcessEnv)?.basicAuth,
    ).toBeNull();
    expect(
      loadOAuthConfig({
        ...FULL,
        TWENTY_BASIC_USER: "twenty",
        TWENTY_BASIC_PASSWORD: "guard",
      } as NodeJS.ProcessEnv)?.basicAuth,
    ).toEqual({ user: "twenty", password: "guard" });
  });
});

describe("twentyProvider", () => {
  const guarded = () => {
    const seen: Array<string | null> = [];
    const stub = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push(auth);
      // A real auth-guard rejects anything that is not its own credential.
      if (!auth?.startsWith("Basic ")) {
        return new Response("401 Authorization Required", { status: 401 });
      }
      return new Response(JSON.stringify(DISCOVERY), {
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", stub);
    return seen;
  };

  const guardedConfig = (password = "guard") =>
    loadOAuthConfig({
      ...FULL,
      TWENTY_BASIC_USER: "twenty",
      TWENTY_BASIC_PASSWORD: password,
    } as NodeJS.ProcessEnv)!;

  test("gets past the wall: discovery carries the guard credentials", async () => {
    const seen = guarded();
    const endpoints = await twentyProvider(guardedConfig()).endpoints();
    expect(endpoints.authorizationEndpoint).toBe("https://twenty.example/oauth/authorize");
    expect(seen[0]).toBe(basicAuthHeader({ user: "twenty", password: "guard" }));
  });

  test("the same call without guard credentials is what fails against a real guard", async () => {
    guarded();
    const unguarded = loadOAuthConfig(FULL as NodeJS.ProcessEnv)!;
    await expect(twentyProvider(unguarded).endpoints()).rejects.toThrow(/401/);
  });

  test("rotating the guard password produces a new provider", () => {
    guarded();
    const first = twentyProvider(guardedConfig("one"));
    const same = twentyProvider(guardedConfig("one"));
    const rotated = twentyProvider(guardedConfig("two"));
    expect(same).toBe(first);
    expect(rotated).not.toBe(first);
  });
});
