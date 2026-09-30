/**
 * Twenty OAuth provider.
 *
 * One object holding everything a surface needs to talk to Twenty as an
 * OAuth provider: client identity, endpoint discovery (cached per instance),
 * and the four operations (authorize URL, code exchange, refresh,
 * introspection). All transport goes through the runtime-agnostic functions in
 * `oauth.ts`, so this provider works in Node, browsers, and Convex actions
 * unchanged.
 *
 * The two fetches are separate on purpose, and that separation is a security
 * property rather than a convenience. A self-hosted Twenty often sits behind an
 * auth-guard proxy that wants HTTP basic auth, and the guard's credentials are
 * correct for discovery and introspection. They are *actively harmful* on the
 * token endpoint: an `Authorization: Basic` header there makes Twenty
 * authenticate the client as a service, and it answers with an APPLICATION_ACCESS
 * token whose `sub` is the application id and whose `userId` /
 * `userWorkspaceId` are placeholders matching no user row. Sign-in then appears
 * to succeed while no record is ever attributed to a person.
 *
 * So the token endpoint is only ever reached through `unguarded`. Wiring this
 * wrong is not possible by omission: the caller names both fetches, and leaving
 * `guarded` unset makes discovery fail loudly against a real guard rather than
 * silently authenticating as a service.
 */

import {
  buildAuthorizeUrl,
  discoverOAuth,
  exchangeCode,
  introspectToken,
  refreshAccessToken,
  registerClient,
  type Introspection,
  type OAuthEndpoints,
  type RegisteredClient,
  type TokenSet,
} from "./oauth.ts";

export interface TwentyProviderConfig {
  baseUrl: string;
  clientId: string;
  /** Always null for the public PKCE client this registers. Kept for a legacy secret. */
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
}

export interface TwentyProviderFetches {
  /**
   * Discovery, code exchange, refresh, and registration. Never carries the
   * guard's basic credentials.
   */
  unguarded?: typeof fetch;
  /**
   * Discovery and introspection, which an auth-guard commonly protects. Omitting
   * it falls back to `unguarded`, which fails loudly with a 401 from a real
   * guard rather than quietly working and mis-attributing every write.
   */
  guarded?: typeof fetch;
}

export class TwentyOAuthProvider {
  private readonly config: TwentyProviderConfig;
  private readonly unguardedFetch: typeof fetch;
  private readonly guardedFetch: typeof fetch;
  private cached: { baseUrl: string; endpoints: OAuthEndpoints } | null = null;

  constructor(config: TwentyProviderConfig, fetches: TwentyProviderFetches = {}) {
    this.config = config;
    this.unguardedFetch = fetches.unguarded ?? fetch;
    this.guardedFetch = fetches.guarded ?? this.unguardedFetch;
  }

  /** Server metadata discovery, cached per base URL on this instance. */
  async endpoints(): Promise<OAuthEndpoints> {
    if (this.cached?.baseUrl === this.config.baseUrl) return this.cached.endpoints;
    const endpoints = await discoverOAuth(this.config.baseUrl, this.guardedFetch);
    this.cached = { baseUrl: this.config.baseUrl, endpoints };
    return endpoints;
  }

  /** The Twenty consent URL the operator's browser is redirected to. */
  async authorizeUrl(input: { state: string; challenge: string; scope?: string; redirectUri?: string }): Promise<string> {
    const endpoints = await this.endpoints();
    return buildAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: this.config.clientId,
      redirectUri: input.redirectUri ?? this.config.redirectUri,
      scope: input.scope ?? this.config.scope,
      state: input.state,
      challenge: input.challenge,
    });
  }

  /** RFC 7591 dynamic registration. Throws when the instance publishes no registration endpoint. */
  async registerClient(input: { clientName: string; redirectUris: string[] }): Promise<RegisteredClient> {
    const endpoints = await this.endpoints();
    if (!endpoints.registrationEndpoint) {
      throw new Error("Twenty instance publishes no registration endpoint");
    }
    return registerClient(endpoints.registrationEndpoint, input, this.unguardedFetch);
  }

  /** Redeem an authorization code. The verifier travels only here. */
  async exchangeCode(input: { code: string; verifier: string; redirectUri?: string }): Promise<TokenSet> {
    const endpoints = await this.endpoints();
    return exchangeCode(
      endpoints.tokenEndpoint,
      {
        code: input.code,
        redirectUri: input.redirectUri ?? this.config.redirectUri,
        verifier: input.verifier,
        auth: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      },
      this.unguardedFetch,
    );
  }

  /** Rotate an expired access token. Null refresh token upstream means re-login. */
  async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
    const endpoints = await this.endpoints();
    return refreshAccessToken(
      endpoints.tokenEndpoint,
      {
        refreshToken,
        auth: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      },
      this.unguardedFetch,
    );
  }

  /**
   * Ask Twenty whether a token is live. This is the user-identity check:
   * Twenty publishes no JWKS, so introspection — not local JWT validation —
   * is how a presented token is verified. Inactive means 401 upstream.
   */
  async introspect(token: string): Promise<Introspection> {
    const endpoints = await this.endpoints();
    if (!endpoints.introspectionEndpoint) {
      throw new Error("Twenty instance publishes no introspection endpoint");
    }
    return introspectToken(
      endpoints.introspectionEndpoint,
      {
        token,
        auth: { clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      },
      this.guardedFetch,
    );
  }
}
