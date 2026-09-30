import { describe, expect, test, vi } from "vitest";
import { authorizedFetch, isExpiredTokenResponse } from "../src/twenty/graphql/helpers/session.ts";
import { createTwentyClient } from "../src/twenty/graphql/helpers/client.ts";
import type { SessionStore, TwentySession } from "../src/twenty/graphql/types.ts";

const SESSION: TwentySession = {
  tokens: { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, scope: "api" },
  obtainedAtMs: 1_000_000,
};

function memoryStore(session: TwentySession | null = SESSION): SessionStore & { saved: TwentySession[]; cleared: number } {
  let current = session;
  const saved: TwentySession[] = [];
  let cleared = 0;
  return {
    saved,
    get cleared() {
      return cleared;
    },
    load: () => current,
    save: (next) => {
      current = next;
      saved.push(next);
    },
    clear: () => {
      current = null;
      cleared += 1;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("isExpiredTokenResponse", () => {
  test("401, GraphQL UNAUTHENTICATED, and nothing else", () => {
    expect(isExpiredTokenResponse(401, "")).toBe(true);
    expect(
      isExpiredTokenResponse(200, JSON.stringify({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] })),
    ).toBe(true);
    expect(isExpiredTokenResponse(200, JSON.stringify({ data: { x: 1 } }))).toBe(false);
    expect(isExpiredTokenResponse(200, "not json")).toBe(false);
    expect(isExpiredTokenResponse(500, "")).toBe(false);
  });
});

describe("authorizedFetch", () => {
  test("injects the session bearer token", async () => {
    const store = memoryStore();
    const seen: Array<{ url: string; auth: string | null }> = [];
    const run = authorizedFetch({
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens: () => {
        throw new Error("must not refresh");
      },
      fetchFn: (async (url, init) => {
        seen.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
        return jsonResponse({ data: { ok: true } });
      }) as typeof fetch,
      nowMs: 1_000_000,
    });
    const response = await run("https://twenty.example/graphql", { method: "POST" });
    expect(seen).toEqual([{ url: "https://twenty.example/graphql", auth: "Bearer at-1" }]);
    expect(await response.json()).toEqual({ data: { ok: true } });
  });

  test("refreshes proactively when expired and preserves a missing rotated refresh token", async () => {
    const store = memoryStore();
    const refreshTokens = vi.fn(async () => ({ accessToken: "at-2", refreshToken: null, expiresIn: 3600 as number | null, scope: "api" }));
    let calls = 0;
    const run = authorizedFetch({
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens,
      fetchFn: (async () => {
        calls += 1;
        return jsonResponse({ data: { ok: true } });
      }) as typeof fetch,
      // expiresIn 3600 from obtainedAtMs 1_000_000 ends at 4_600_000; skew pulls it earlier.
      nowMs: 4_600_000,
    });
    await run("https://twenty.example/graphql", {});
    expect(refreshTokens).toHaveBeenCalledWith("rt-1");
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.tokens).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
    expect(calls).toBe(1);
  });

  test("replays once after a 401, then gives up to sign-in on refresh failure", async () => {
    const store = memoryStore();
    let calls = 0;
    const run = authorizedFetch({
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens: async () => {
        throw new Error("refresh rejected");
      },
      fetchFn: (async () => {
        calls += 1;
        return jsonResponse({ errors: [{ message: "no" }] }, 401);
      }) as typeof fetch,
      nowMs: 1_000_000,
    });
    await expect(run("https://twenty.example/graphql", {})).rejects.toThrow("Session expired");
    expect(calls).toBe(1);
    expect(store.cleared).toBe(1);
  });

  test("replays after GraphQL UNAUTHENTICATED inside a 200", async () => {
    const store = memoryStore();
    const seen: Array<string | null> = [];
    let calls = 0;
    const run = authorizedFetch({
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens: async () => ({ accessToken: "at-9", refreshToken: "rt-9", expiresIn: 3600, scope: "api" }),
      fetchFn: (async (_url, init) => {
        calls += 1;
        seen.push(new Headers(init?.headers).get("Authorization"));
        return calls === 1
          ? jsonResponse({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] })
          : jsonResponse({ data: { ok: true } });
      }) as typeof fetch,
      nowMs: 1_000_000,
    });
    const response = await run("https://twenty.example/graphql", {});
    expect(await response.json()).toEqual({ data: { ok: true } });
    expect(seen).toEqual(["Bearer at-1", "Bearer at-9"]);
  });

  test("no session means not authenticated", async () => {
    const store = memoryStore(null);
    const run = authorizedFetch({
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens: async () => ({ accessToken: "x", refreshToken: null, expiresIn: null, scope: null }),
      nowMs: 1_000_000,
    });
    await expect(run("https://twenty.example/graphql", {})).rejects.toThrow("Not authenticated");
  });
});

describe("createTwentyClient", () => {
  test("binds url and authed fetch into the generated factory", async () => {
    const store = memoryStore();
    let captured: { url: string } | null = null;
    const client = createTwentyClient({
      graphqlUrl: "https://twenty.example/graphql",
      createClient: (options: { url: string; fetch: typeof fetch }) => {
        captured = { url: options.url };
        return {
          query: async <R,>(request: unknown): Promise<R> => ({ echoed: request }) as R,
          mutation: async <R,>(request: unknown): Promise<R> => ({ echoed: request }) as R,
        };
      },
      loadSession: store.load,
      saveSession: store.save,
      clearSession: store.clear,
      refreshTokens: async () => ({ accessToken: "x", refreshToken: null, expiresIn: null, scope: null }),
      fetchFn: (async () => jsonResponse({ data: { ok: true } })) as typeof fetch,
      nowMs: 1_000_000,
    });
    expect(captured).toEqual({ url: "https://twenty.example/graphql" });
    await expect(client.query({ agencyPhones: { id: true } })).resolves.toEqual({
      echoed: { agencyPhones: { id: true } },
    });
  });
});
