/**
 * Twenty OAuth 2.0 client (authorization code + PKCE, refresh, introspect).
 *
 * Twenty is its own OAuth provider (see
 * `{TWENTY_BASE_URL}/.well-known/oauth-authorization-server`): dynamic client
 * registration per RFC 7591, S256 PKCE, `api` and `profile` scopes, standard
 * token/refresh/introspect endpoints. This module speaks that surface with
 * nothing but global fetch and WebCrypto, so the same code runs in the CLI
 * (Node), the web app (browser), and Convex actions.
 *
 * Two clients share these helpers:
 *
 *   - the web app runs the full code flow as a public SPA client: verifier in
 *     sessionStorage, authorize redirect, code redemption (proxied through
 *     the Hono API so CORS can never block it).
 *   - the CLI opens the web `/login` page with its own state + challenge; the
 *     page signs the operator in and POSTs the resulting Twenty tokens back
 *     to the loopback exchange, which the CLI accepts only on a state and
 *     challenge echo.
 */

export class TwentyOAuthError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Twenty OAuth ${status}: ${detail}`);
    this.name = "TwentyOAuthError";
    this.status = status;
  }
}

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  introspectionEndpoint: string | null;
  revocationEndpoint: string | null;
}

export interface RegisteredClient {
  clientId: string;
  clientSecret: string | null;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

export interface Introspection {
  active: boolean;
  username: string | null;
  scope: string | null;
  expiresAt: number | null;
  /**
   * RFC 7662 subject.
   *
   * This is NOT the human. For a Twenty application access token it is the
   * *application* id, and an application token's `userId` / `userWorkspaceId`
   * are placeholders that match no user row. Resolving a member from `sub` is
   * the bug PR 11 fixed in the dialer; read the identity from the access token
   * with `decodeJwtPayload` instead. See `twenty/workspaceMember`.
   */
  sub: string | null;
  email: string | null;
  /**
   * The whole RFC 7662 response, unfiltered.
   *
   * Twenty publishes no `userinfo_endpoint` and no current-user query, so this
   * is the only view of the token besides the JWT itself. It is kept rather
   * than narrowed to a few named fields because which claim carries the
   * sign-in email varies by deployment, and `emailsFromClaims` reads whatever
   * is present instead of trusting one field this instance leaves empty.
   */
  claims: Record<string, unknown>;
}

/**
 * The claims a user-authorized Twenty access token carries.
 *
 * `sub` is listed for completeness and is deliberately not used for identity:
 * see `Introspection.sub`.
 */
export interface TwentyAccessTokenClaims {
  sub?: string;
  applicationId?: string;
  workspaceId?: string;
  /** The authenticated Twenty user. Resolves a `workspaceMember.userId`. */
  userId?: string;
  /** The workspace member the token was minted in. Resolves a member id. */
  userWorkspaceId?: string;
  type?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

type FetchFn = typeof fetch;

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * base64url without padding, from raw bytes. Hand-rolled so this module
 * needs no runtime globals: no btoa (absent in Convex/Node types), no
 * Buffer (absent in browsers).
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "";
    out += i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "";
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * Decode a JWT payload without verifying its signature.
 *
 * This is safe here for one specific reason and must not be read as a general
 * licence to trust a JWT: introspection has already established that the token
 * is live, and introspection is the trust boundary. Twenty publishes no JWKS, so
 * there is nothing to verify against even if we wanted to.
 *
 * It is here because the human identity is only in the token. Introspection
 * reports `sub` as the *application* id, which is useless for attribution; the
 * `userId` and `userWorkspaceId` claims are what actually name a person.
 *
 * Hand-rolled from the alphabet, like `base64UrlEncode` above, so it needs no
 * Buffer and no atob and behaves identically in Node, a browser, and Convex.
 */
export function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TwentyOAuthError(502, "Twenty access token is not a JWT");
  }

  const encoded = parts[1] ?? "";
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  // "=" is the padding terminator, not an alphabet member, so it is mapped to
  // the sentinel 64 rather than looked up. Looking it up yields -1, which is
  // what makes a decoder reject every payload whose length is not a multiple of
  // 3 -- and a token payload almost never is, so "pad, then look it up" fails
  // on most real tokens and works only by luck.
  const value = (char: string | undefined): number =>
    char === undefined || char === "=" ? 64 : BASE64_ALPHABET.indexOf(char);

  const bytes: number[] = [];
  for (let i = 0; i < padded.length; i += 4) {
    const a = value(padded[i]);
    const b = value(padded[i + 1]);
    const c = value(padded[i + 2]);
    const d = value(padded[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new TwentyOAuthError(502, "Twenty access token has an invalid JWT payload");
    }
    bytes.push((a << 2) | (b >> 4));
    if (c !== 64) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d !== 64) bytes.push(((c & 3) << 6) | d);
  }

  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
  } catch {
    throw new TwentyOAuthError(502, "Twenty access token has an invalid JWT payload");
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every email-shaped string in a set of token claims.
 *
 * A deployment is under no obligation to put the sign-in address in a named
 * claim, and this one does not reliably, so any claim that looks like an email
 * is taken. Insertion order is preserved and duplicates dropped, so a token
 * carrying two email claims always resolves the same way on every run.
 */
export function emailsFromClaims(claims: Record<string, unknown> | null | undefined): string[] {
  const found: string[] = [];
  for (const value of Object.values(claims ?? {})) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (EMAIL_RE.test(trimmed) && !found.includes(trimmed)) found.push(trimmed);
  }
  return found;
}

/** Filter crypto.getRandomValues through an injectable source for tests. */
export function randomBase64Url(
  byteLength: number,
  rand: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  return base64UrlEncode(rand(new Uint8Array(byteLength)));
}

/** 32 random bytes: 43 chars, inside the RFC 7636 43-128 bound. */
export function generateCodeVerifier(): string {
  return randomBase64Url(32);
}

/** 16 random bytes: the per-flow state nonce. */
export function generateState(): string {
  return randomBase64Url(16);
}

/** S256 challenge: base64url(SHA256(verifier)). Async — WebCrypto only. */
export async function codeChallengeForVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Server metadata discovery. Endpoint paths come from the document, never
 * from string constants, so self-hosted instances with different paths work.
 */
export async function discoverOAuth(baseUrl: string, fetchFn: FetchFn = fetch): Promise<OAuthEndpoints> {
  const response = await fetchFn(joinUrl(baseUrl, ".well-known/oauth-authorization-server"));
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  const doc = (await response.json()) as Record<string, unknown>;
  const pick = (name: string, required: boolean): string | null => {
    const value = doc[name];
    if (typeof value === "string" && value !== "") return new URL(value, baseUrl).toString();
    if (required) throw new TwentyOAuthError(502, `Twenty discovery document has no ${name}`);
    return null;
  };
  return {
    authorizationEndpoint: pick("authorization_endpoint", true) as string,
    tokenEndpoint: pick("token_endpoint", true) as string,
    registrationEndpoint: pick("registration_endpoint", false),
    introspectionEndpoint: pick("introspection_endpoint", false),
    revocationEndpoint: pick("revocation_endpoint", false),
  };
}

/**
 * RFC 7591 dynamic client registration, as a public PKCE client.
 *
 * `token_endpoint_auth_method: "none"` is the whole point, and getting it wrong
 * is not cosmetic. A client registered as `client_secret_post` is confidential:
 * the token endpoint then authenticates the *client* rather than the user, and
 * Twenty answers with an APPLICATION_ACCESS token whose `sub` is the
 * application id and whose `userId` / `userWorkspaceId` are placeholders that
 * match no user row. Sign-in appears to work and no record is ever attributed
 * to a person.
 *
 * A public client has no secret to keep, which is also why `clientAuthBody`
 * omits it rather than sending an empty value.
 */
export async function registerClient(
  registrationEndpoint: string,
  input: { clientName: string; redirectUris: string[] },
  fetchFn: FetchFn = fetch,
): Promise<RegisteredClient> {
  const response = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: input.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  const body = (await response.json()) as { client_id?: unknown; client_secret?: unknown };
  if (typeof body.client_id !== "string" || body.client_id === "") {
    throw new TwentyOAuthError(502, "Twenty registration returned no client_id");
  }
  return {
    clientId: body.client_id,
    // A public client is issued no secret. One that arrives anyway is ignored
    // rather than stored, so a deployment cannot drift back to sending it.
    clientSecret: null,
  };
}

export function buildAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

interface ClientAuth {
  clientId: string;
  clientSecret: string | null;
}

function clientAuthBody(auth: ClientAuth): Record<string, string> {
  // Twenty advertises `client_secret_post` and `none`: secreted clients post
  // it, public clients omit it. Never put it in the URL.
  return auth.clientSecret
    ? { client_id: auth.clientId, client_secret: auth.clientSecret }
    : { client_id: auth.clientId };
}

function toTokenSet(body: Record<string, unknown>): TokenSet {
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new TwentyOAuthError(502, "Twenty token endpoint returned no access_token");
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : null,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

async function postForm(
  endpoint: string,
  params: Record<string, string>,
  fetchFn: FetchFn,
): Promise<Record<string, unknown>> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    throw new TwentyOAuthError(response.status, (await response.text().catch(() => "")).slice(0, 300));
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Redeem an authorization code. The verifier never travels except here. */
export async function exchangeCode(
  tokenEndpoint: string,
  input: { code: string; redirectUri: string; verifier: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(
      tokenEndpoint,
      {
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
        ...clientAuthBody(input.auth),
      },
      fetchFn,
    ),
  );
}

/** Rotate an expired access token. Null refresh token means re-login. */
export async function refreshAccessToken(
  tokenEndpoint: string,
  input: { refreshToken: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<TokenSet> {
  return toTokenSet(
    await postForm(
      tokenEndpoint,
      { grant_type: "refresh_token", refresh_token: input.refreshToken, ...clientAuthBody(input.auth) },
      fetchFn,
    ),
  );
}

/**
 * Ask Twenty whether a token is live. This is how backends validate
 * operator tokens without a JWKS: introspection is the documented
 * mechanism, and `active: false` is the only answer that matters.
 */
export async function introspectToken(
  introspectionEndpoint: string,
  input: { token: string; auth: ClientAuth },
  fetchFn: FetchFn = fetch,
): Promise<Introspection> {
  const body = await postForm(
    introspectionEndpoint,
    { token: input.token, ...clientAuthBody(input.auth) },
    fetchFn,
  );
  return {
    active: body.active === true,
    username: typeof body.username === "string" ? body.username : null,
    scope: typeof body.scope === "string" ? body.scope : null,
    expiresAt: typeof body.exp === "number" ? body.exp : null,
    sub: typeof body.sub === "string" ? body.sub : null,
    email: typeof body.email === "string" ? body.email : null,
    claims: body,
  };
}

/** True when `expiresIn` seconds from `obtainedAtMs` have passed (60s skew). */
export function isTokenExpired(obtainedAtMs: number, expiresIn: number | null, nowMs = Date.now()): boolean {
  if (expiresIn === null) return false;
  return nowMs >= obtainedAtMs + expiresIn * 1000 - 60_000;
}
