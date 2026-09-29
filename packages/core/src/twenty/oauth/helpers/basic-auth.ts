/**
 * Getting past the wall in front of Twenty.
 *
 * A self-hosted Twenty instance can sit behind an auth-guard proxy that
 * demands HTTP basic auth on every path. That guard is what makes an operator
 * see a native `user:pass` prompt the first time the browser hits /authorize,
 * and it is also why a server-side call to `/.well-known/oauth-authorization-server`
 * or `/oauth/token` answers 401 before OAuth is even attempted.
 *
 * The record and GraphQL APIs are the exception: a guard that exempts
 * /rest and /graphql serves those with the workspace's own bearer token alone,
 * which is why the API key path needs nothing from this file. Everything that
 * talks to the OAuth endpoints needs it.
 *
 * The header is built without Buffer or btoa so the same helper is correct in
 * Node, Convex, and the browser. Standard base64 with padding, unlike the
 * base64url used for PKCE.
 */

export interface BasicCredentials {
  user: string;
  password: string;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `Basic base64(user:password)`, with the padding real basic auth expects. */
export function basicAuthHeader(credentials: BasicCredentials): string {
  const input = new TextEncoder().encode(`${credentials.user}:${credentials.password}`);
  let out = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i] as number;
    const b = i + 1 < input.length ? (input[i + 1] as number) : 0;
    const c = i + 2 < input.length ? (input[i + 2] as number) : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64_ALPHABET[(triple >> 18) & 63];
    out += BASE64_ALPHABET[(triple >> 12) & 63];
    out += i + 1 < input.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    out += i + 2 < input.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return `Basic ${out}`;
}

/**
 * Wrap a fetch so every request also presents the guard's basic credentials.
 *
 * Authorization is overwritten rather than merged on purpose: basic auth owns
 * the header on the OAuth endpoints, and a caller that set a bearer token for
 * the same request would otherwise be silently shadowed.
 */
export function withBasicAuth(
  credentials: BasicCredentials,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  const header = basicAuthHeader(credentials);
  return (async (input, init) =>
    fetchFn(input, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: header },
    })) as typeof fetch;
}
