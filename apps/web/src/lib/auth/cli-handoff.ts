/**
 * The `blaster login` handoff, carried by the ordinary sign-in pages.
 *
 * There are exactly two pages in this app: `/login` and `/callback`. The CLI
 * needs a browser to finish Twenty's login and get the tokens back to a terminal,
 * and this module is the whole of that bridge — there is no third page for it,
 * because a separate route would be a second place where the same OAuth flow
 * lives, and two copies of sign-in drift.
 *
 * So `blaster login` opens `/login` carrying three values: the `state` it
 * generated, the PKCE `code_challenge` it committed to, and the loopback
 * `exchange` URL it is listening on. Twenty's round trip drops the query string,
 * so the values are mirrored into sessionStorage on arrival and the return marker
 * brings `/callback` back here instead of home.
 *
 *   no exchange, no session  -> sign in as usual
 *   exchange, no session      -> sign in, then post the tokens to the terminal
 *   exchange, session         -> post the tokens, report the outcome
 *
 * Tokens are never rendered. The exchange response shows as ok or fail.
 */

const STORAGE_KEY = "blaster.cli.exchange";
const RETURN_KEY = "blaster.oauth.return";

/**
 * sessionStorage, or an in-memory stand-in.
 *
 * Read through `globalThis` rather than `window` so this module can be imported
 * outside a browser without throwing, which is what lets it be unit tested in a
 * Node environment rather than only inside a page. The fallback is per-process
 * and never shared, so a browser without storage degrades to "the run is lost"
 * instead of leaking a session somewhere.
 */
const memory = new Map<string, string>();

function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const real = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  if (real) return real;
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  };
}

/** The current query string, or empty when there is no document. */
function currentSearch(): string {
  return (globalThis as { location?: { search?: string } }).location?.search ?? "";
}

/**
 * Only a loopback exchange is accepted.
 *
 * This is a browser handing credentials to a process on this machine, so the URL
 * is restricted to loopback rather than trusted because it came from a query
 * string. Anything else is ignored, which leaves a plain sign-in working.
 */
const EXCHANGE_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/exchange$/;

export interface CliExchange {
  state: string;
  codeChallenge: string;
  exchangeUrl: string;
}

export function isCliExchange(value: unknown): value is CliExchange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CliExchange>;
  return (
    typeof candidate.state === "string" &&
    candidate.state !== "" &&
    typeof candidate.codeChallenge === "string" &&
    candidate.codeChallenge !== "" &&
    typeof candidate.exchangeUrl === "string" &&
    EXCHANGE_RE.test(candidate.exchangeUrl)
  );
}

function parseParams(search: string): CliExchange | null {
  const params = new URLSearchParams(search);
  const candidate = {
    state: params.get("state") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    exchangeUrl: params.get("exchange") ?? "",
  };
  return isCliExchange(candidate) ? candidate : null;
}

/** Read the exchange from the URL, mirroring it into sessionStorage if present. */
export function readCliExchange(search: string = currentSearch()): CliExchange | null {
  const fromUrl = parseParams(search);
  if (fromUrl) {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify(fromUrl));
    } catch {
      // Private-mode denial only costs the post-sign-in recovery path.
    }
    return fromUrl;
  }
  return readStoredCliExchange();
}

/** The mirrored exchange, from an earlier visit in this tab. */
export function readStoredCliExchange(): CliExchange | null {
  try {
    const raw = storage().getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isCliExchange(parsed)) {
      storage().removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearCliExchange(): void {
  try {
    storage().removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Remember where to come back to, because Twenty drops the query string. */
export function markOAuthReturn(): void {
  try {
    const here = (globalThis as { location?: { pathname?: string; search?: string } }).location;
    storage().setItem(RETURN_KEY, `${here?.pathname ?? "/login"}${here?.search ?? ""}`);
  } catch {
    // Without the marker the operator lands home and can reopen the CLI URL.
  }
}

/**
 * Consume the return marker.
 *
 * A plain sign-in has none and goes home. A CLI sign-in returns to the page it
 * started from, which is the one carrying the exchange, so the tokens can still
 * reach the terminal waiting on it.
 */
export function readOAuthReturn(): string {
  try {
    const target = storage().getItem(RETURN_KEY);
    storage().removeItem(RETURN_KEY);
    if (target && target.startsWith("/")) return target;
  } catch {
    // Fall through to home.
  }
  return "/";
}

export interface CliSession {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

export type CliExchangeResult =
  | { kind: "idle" | "posting" }
  | { kind: "ok" }
  | { kind: "error"; detail: string; retryable: boolean };

/**
 * Hand the session to the terminal waiting on the loopback.
 *
 * The CLI accepts the post only when the state and challenge match the run it
 * started, so an intercepted request is useless without the verifier it never
 * saw. A 401 is the interesting failure: it means the terminal is listening but
 * this exchange is not its current run, which is worth a retry because the
 * operator may have started a second `blaster login` in another window.
 */
export async function postCliExchange(
  exchange: CliExchange,
  session: CliSession,
  fetchFn: typeof fetch = fetch,
): Promise<CliExchangeResult> {
  try {
    const response = await fetchFn(exchange.exchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: exchange.state,
        code_challenge: exchange.codeChallenge,
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        expires_in: session.expiresIn,
        token_type: "Bearer",
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (response.ok && body.ok) return { kind: "ok" };
    return {
      kind: "error",
      detail: body.error ?? `The CLI rejected the exchange (HTTP ${response.status}).`,
      retryable: response.status === 401,
    };
  } catch (error) {
    return {
      kind: "error",
      detail: `Could not reach the CLI at ${exchange.exchangeUrl}. It may have finished or timed out, so run blaster login again. (${
        error instanceof Error ? error.message : String(error)
      })`,
      retryable: false,
    };
  }
}
