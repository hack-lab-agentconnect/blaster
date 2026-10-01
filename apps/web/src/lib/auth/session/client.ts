import {
  buildAuthorizeUrl,
  codeChallengeForVerifier,
  generateCodeVerifier,
  generateState,
  type TokenSet,
} from "@blaster/core/twenty/oauth";
import type { OperatorIdentity, OperatorSession, PendingFlow, PublicAuthConfig } from "./types.ts";

/**
 * Operator session against Twenty (Twenty is the identity provider).
 *
 * Sign-in is a standard SPA code flow with S256 PKCE: the verifier lives in
 * sessionStorage, the browser is redirected to Twenty's authorize endpoint,
 * Twenty returns to /callback, and the code is redeemed through the Hono
 * `/api/auth/token` proxy — the client secret never reaches the browser and
 * Twenty's CORS posture never matters. Tokens stay in sessionStorage, so a
 * closed tab signs the operator out.
 *
 * All storage and network access lives here in the client, never in pages:
 * pages render state and call these functions.
 */

const SESSION_KEY = "blaster.operator.session";
const PENDING_KEY = "blaster.oauth.pending";

async function publicConfig(): Promise<PublicAuthConfig> {
  const response = await fetch("/api/auth/config");
  if (!response.ok) throw new Error("Twenty OAuth is not configured on the API");
  return (await response.json()) as PublicAuthConfig;
}

function readSession(): OperatorSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OperatorSession;
    if (!parsed?.tokens?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(session: OperatorSession): void {
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
}

export function loadSession(): OperatorSession | null {
  return readSession();
}

/** Start sign-in: stash the verifier, redirect to Twenty. */
export async function beginSignIn(): Promise<void> {
  const config = await publicConfig();
  const verifier = generateCodeVerifier();
  const state = generateState();
  const pending: PendingFlow = { verifier, state };
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  window.location.assign(
    buildAuthorizeUrl({
      authorizationEndpoint: config.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
      state,
      challenge: await codeChallengeForVerifier(verifier),
    }),
  );
}

/** Finish sign-in on /callback: verify state, redeem the code via the proxy. */
export async function finishSignIn(search: string): Promise<OperatorSession> {
  const params = new URLSearchParams(search);
  const code = params.get("code") ?? "";
  const returnedState = params.get("state") ?? "";
  if (params.get("error")) {
    throw new Error(`Twenty refused authorization: ${params.get("error_description") ?? params.get("error")}`);
  }
  if (!code) throw new Error("Twenty returned no authorization code");

  // React StrictMode runs effects twice in development, so this runs twice
  // with the same code. A second call joins the first instead of redeeming the
  // code again, which the provider would reject as already used.
  const cacheKey = `${PENDING_KEY}:${code}`;
  const inFlight = exchanges.get(cacheKey);
  if (inFlight && inFlight.state === returnedState) return inFlight.promise;

  const raw = window.sessionStorage.getItem(PENDING_KEY);
  const pending = (raw ? JSON.parse(raw) : null) as PendingFlow | null;
  if (!pending || pending.state !== returnedState) {
    throw new Error("OAuth state mismatch. Start sign-in again.");
  }

  const promise = redeem(code, pending.verifier).catch((error: unknown) => {
    exchanges.delete(cacheKey);
    throw error;
  });
  exchanges.set(cacheKey, { state: returnedState, promise });
  try {
    return await promise;
  } finally {
    exchanges.delete(cacheKey);
  }
}

const exchanges = new Map<string, { state: string; promise: Promise<OperatorSession> }>();

async function redeem(code: string, verifier: string): Promise<OperatorSession> {
  const response = await fetch("/api/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  if (!response.ok) throw new Error("Code redemption failed. Start sign-in again.");
  const body = (await response.json()) as { tokens: TokenSet };
  const session: OperatorSession = { tokens: body.tokens, obtainedAtMs: Date.now() };
  writeSession(session);
  // Cleared only once the tokens are stored: a StrictMode re-run re-validates
  // against this entry instead of failing on an already-deleted key.
  window.sessionStorage.removeItem(PENDING_KEY);
  return session;
}

/** Who is signed in, per the API (which introspects against Twenty). */
export async function fetchOperator(): Promise<OperatorIdentity | null> {
  const session = readSession();
  if (!session) return null;
  const response = await fetch("/api/auth/me", {
    headers: { Authorization: `Bearer ${session.tokens.accessToken}` },
  });
  if (!response.ok) return null;
  return (await response.json()) as OperatorIdentity;
}

/** Refresh the stored session. Null refresh token means sign in again. */
export async function refreshSession(): Promise<OperatorSession | null> {
  const session = readSession();
  const refreshToken = session?.tokens.refreshToken;
  if (!refreshToken) return null;
  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    clearSession();
    return null;
  }
  const body = (await response.json()) as { tokens: TokenSet };
  const next: OperatorSession = {
    tokens: { ...body.tokens, refreshToken: body.tokens.refreshToken ?? refreshToken },
    obtainedAtMs: Date.now(),
  };
  writeSession(next);
  return next;
}
