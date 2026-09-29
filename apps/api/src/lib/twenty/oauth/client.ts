import {
  TwentyOAuthProvider,
  withBasicAuth,
  type Introspection,
  type OAuthEndpoints,
  type TokenSet,
} from "@blaster/core";
import { loadOAuthConfig } from "./helpers/index.ts";
import type { OAuthServerConfig } from "./types.ts";

let cachedProvider: { key: string; provider: TwentyOAuthProvider } | null = null;

export function twentyProvider(config: OAuthServerConfig): TwentyOAuthProvider {
  // The basic-auth user is part of the cache key: rotating the guard password
  // must produce a new provider rather than reuse the one holding the old one.
  const key = `${config.baseUrl} ${config.clientId} ${config.redirectUri} ${config.scope} ${
    config.basicAuth?.user ?? ""
  } ${config.basicAuth?.password ?? ""}`;
  if (cachedProvider?.key !== key) {
    cachedProvider = {
      key,
      provider: new TwentyOAuthProvider(
        {
          baseUrl: config.baseUrl,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
          scope: config.scope,
        },
        // Discovery, token, and introspection calls go to paths an
        // auth-guard proxy protects, so they carry the gate credentials too.
        config.basicAuth ? withBasicAuth(config.basicAuth) : fetch,
      ),
    };
  }
  return cachedProvider.provider;
}

export async function oauthEndpoints(baseUrl: string): Promise<OAuthEndpoints> {
  const config = loadOAuthConfig();
  if (config && config.baseUrl === baseUrl) {
    return twentyProvider(config).endpoints();
  }
  return new TwentyOAuthProvider({
    baseUrl,
    clientId: "",
    clientSecret: null,
    redirectUri: "",
    scope: "",
  }).endpoints();
}

export async function exchangeAuthorizationCode(
  config: OAuthServerConfig,
  input: { code: string; verifier: string; redirectUri?: string },
): Promise<TokenSet> {
  return twentyProvider(config).exchangeCode(input);
}

export async function refreshOperatorToken(
  config: OAuthServerConfig,
  refreshToken: string,
): Promise<TokenSet> {
  return twentyProvider(config).refreshAccessToken(refreshToken);
}

/** Introspect a presented Bearer token. Inactive or unknown means 401. */
export async function checkOperatorToken(
  config: OAuthServerConfig,
  token: string,
): Promise<Introspection> {
  return twentyProvider(config).introspect(token);
}
