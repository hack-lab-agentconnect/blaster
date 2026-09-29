/**
 * Authenticated fetch for Twenty GraphQL.
 *
 * Mirrors the proven shape: send with the session's access token, and when
 * the instance rejects it as expired, refresh once and replay. Expiry is
 * not a 401 here — Twenty answers 200 with an UNAUTHENTICATED error inside
 * the GraphQL payload — so the body is inspected too, then handed back as a
 * fresh Response because a read body cannot be re-read by the caller.
 */

import { isTokenExpired } from "../../oauth/helpers/oauth.ts";
import type { GraphqlErrorEntry, SessionStore, TokenRefresher, TwentySession } from "../types.ts";

export function isExpiredTokenResponse(status: number, body: string): boolean {
  if (status === 401) return true;
  try {
    const parsed = JSON.parse(body) as { errors?: GraphqlErrorEntry[] };
    return Boolean(parsed.errors?.some((error) => error.extensions?.code === "UNAUTHENTICATED"));
  } catch {
    return false;
  }
}

const replay = (response: Response, body: string): Response =>
  new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

export interface AuthorizedFetchOptions {
  loadSession: SessionStore["load"];
  saveSession: SessionStore["save"];
  clearSession: SessionStore["clear"];
  refreshTokens: TokenRefresher;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

/** Build a fetch that injects the session token and refreshes once on expiry. */
export function authorizedFetch(options: AuthorizedFetchOptions): typeof fetch {
  const fetchFn = options.fetchFn ?? fetch;
  const send = async (tokens: { accessToken: string }, url: string, init: RequestInit = {}) =>
    fetchFn(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${tokens.accessToken}` },
    });

  return (async (url, init) => {
    const target = String(url);
    let session: TwentySession | null = await options.loadSession();
    if (!session) throw new Error("Not authenticated");
    if (isTokenExpired(session.obtainedAtMs, session.tokens.expiresIn, options.nowMs)) {
      session = await rotate(options, session);
    }
    const response = await send(session.tokens, target, init as RequestInit);
    const body = await response.text();
    if (!isExpiredTokenResponse(response.status, body)) return replay(response, body);
    try {
      session = await rotate(options, session);
    } catch {
      await options.clearSession();
      throw new Error("Session expired: please sign in again");
    }
    const retried = await send(session.tokens, target, init as RequestInit);
    return replay(retried, await retried.text());
  }) as typeof fetch;
}

async function rotate(
  options: AuthorizedFetchOptions,
  session: TwentySession,
): Promise<TwentySession> {
  const refreshToken = session.tokens.refreshToken;
  if (!refreshToken) throw new Error("No refresh token: please sign in again");
  const tokens = await options.refreshTokens(refreshToken);
  const next: TwentySession = {
    tokens: { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken },
    obtainedAtMs: options.nowMs ?? Date.now(),
  };
  await options.saveSession(next);
  return next;
}
