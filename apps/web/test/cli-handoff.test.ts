/**
 * The CLI handoff that the ordinary sign-in pages carry.
 *
 * `blaster login` has no page of its own, so this logic is the only bridge
 * between a browser holding Twenty tokens and a terminal waiting on a loopback.
 * What matters is that it cannot be talked into sending a session anywhere else,
 * and that losing the query string does not lose the run.
 *
 * No jsdom: the module reads its storage through `globalThis` and falls back to
 * memory, so it imports cleanly in the Node environment the suite already runs.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  clearCliExchange,
  isCliExchange,
  markOAuthReturn,
  postCliExchange,
  readCliExchange,
  readOAuthReturn,
  readStoredCliExchange,
} from "../src/lib/auth/cli-handoff";

const LOOPBACK = "http://127.0.0.1:5555/exchange";
const QUERY = `?state=st-1&code_challenge=ch-1&exchange=${encodeURIComponent(LOOPBACK)}`;

/**
 * Both keys are consumed, not deleted, so leaving state behind between cases
 * would make a later test inherit an earlier run.
 */
beforeEach(() => {
  clearCliExchange();
  readOAuthReturn();
});
afterEach(() => vi.restoreAllMocks());

describe("isCliExchange", () => {
  test("accepts a loopback exchange with a state and a challenge", () => {
    expect(isCliExchange({ state: "s", codeChallenge: "c", exchangeUrl: LOOPBACK })).toBe(true);
  });

  test("refuses anything that is not a loopback exchange", () => {
    // The query string is attacker-influenced in the sense that it arrives from
    // whatever opened the page, so the destination is checked rather than trusted.
    expect(isCliExchange({ state: "s", codeChallenge: "c", exchangeUrl: "https://evil.example/exchange" })).toBe(false);
    expect(isCliExchange({ state: "s", codeChallenge: "c", exchangeUrl: "http://127.0.0.1.evil.test/exchange" })).toBe(false);
    expect(isCliExchange({ state: "", codeChallenge: "c", exchangeUrl: LOOPBACK })).toBe(false);
    expect(isCliExchange({ state: "s", codeChallenge: "", exchangeUrl: LOOPBACK })).toBe(false);
    expect(isCliExchange(null)).toBe(false);
    expect(isCliExchange("nope")).toBe(false);
  });
});

describe("readCliExchange", () => {
  test("reads all three values out of the URL the CLI opened", () => {
    expect(readCliExchange(QUERY)).toEqual({ state: "st-1", codeChallenge: "ch-1", exchangeUrl: LOOPBACK });
  });

  test("mirrors it, so the Twenty round trip does not lose the run", () => {
    readCliExchange(QUERY);
    // Twenty returns to /callback with an empty query string; without the mirror
    // the terminal would be waiting for a post that can never arrive.
    expect(readCliExchange("")).toEqual({ state: "st-1", codeChallenge: "ch-1", exchangeUrl: LOOPBACK });
  });

  test("a bare sign-in has no exchange, and is not a CLI run", () => {
    expect(readCliExchange("")).toBeNull();
    expect(readCliExchange("?state=only-state")).toBeNull();
  });

  test("a stale /cli link with a partial query is not treated as a run", () => {
    // This is the link an older session left behind: a state and nothing else.
    expect(readCliExchange("?state=jS28FjnIHBGxs6mwFrsuOw")).toBeNull();
    expect(readStoredCliExchange()).toBeNull();
  });

  test("clearing removes the mirror, so one exchange is not posted twice", () => {
    readCliExchange(QUERY);
    clearCliExchange();
    expect(readStoredCliExchange()).toBeNull();
  });
});

describe("the return marker", () => {
  test("comes back to the page that started the flow", () => {
    // The marker records where the operator was, so a location is what it reads.
    // Twenty returns to /callback with no query, and without this the run is lost.
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/login", search: QUERY },
    });
    markOAuthReturn();
    expect(readOAuthReturn()).toBe("/login" + QUERY);
  });

  test("with no document, it still returns somewhere safe", () => {
    // Importable outside a browser, so it has to behave rather than throw.
    Object.defineProperty(globalThis, "location", { configurable: true, value: undefined });
    markOAuthReturn();
    expect(readOAuthReturn()).toBe("/login");
  });

  test("is consumed once, so a later plain sign-in still goes home", () => {
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { pathname: "/login", search: QUERY },
    });
    markOAuthReturn();
    readOAuthReturn();
    expect(readOAuthReturn()).toBe("/");
  });

  test("a plain sign-in has no marker and goes home", () => {
    expect(readOAuthReturn()).toBe("/");
  });
});

describe("postCliExchange", () => {
  const okResponse = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });

  test("posts the session to the loopback and reports success", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return okResponse();
    }) as typeof fetch;

    const result = await postCliExchange(
      { state: "st-1", codeChallenge: "ch-1", exchangeUrl: LOOPBACK },
      { accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600 },
      fetchFn,
    );

    expect(result.kind).toBe("ok");
    expect(calls[0]?.url).toBe(LOOPBACK);
    // The state and challenge travel together so the terminal can bind the post
    // to the run it started.
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      state: "st-1",
      code_challenge: "ch-1",
      access_token: "at-1",
      refresh_token: "rt-1",
      expires_in: 3600,
      token_type: "Bearer",
    });
  });

  test("a 401 is retryable, because it means another run is listening", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: "not the run that started this exchange" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const result = await postCliExchange(
      { state: "s", codeChallenge: "c", exchangeUrl: LOOPBACK },
      { accessToken: "a", refreshToken: null, expiresIn: null },
      fetchFn,
    );
    expect(result).toMatchObject({ kind: "error", retryable: true });
  });

  test("a terminal that is gone says so and is not retryable", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await postCliExchange(
      { state: "s", codeChallenge: "c", exchangeUrl: LOOPBACK },
      { accessToken: "a", refreshToken: null, expiresIn: null },
      fetchFn,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.retryable).toBe(false);
    // The remedy is in the message, because the operator has to act on it.
    expect(result.detail).toMatch(/blaster login/);
  });
});
