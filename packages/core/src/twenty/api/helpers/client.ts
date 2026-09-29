/**
 * Session-bound Twenty GraphQL client factory.
 *
 * This is the single construction point every surface uses now that
 * `pnpm twenty:client` has emitted `generated/`: pass the generated
 * `createClient` and a session store, get back the generated client with its
 * full workspace typing, already carrying OAuth tokens with refresh.
 *
 * The option is generic over the factory it is given and returns that
 * factory's own client type on purpose. Importing the generated `Client`
 * type here would drag an 8 MB workspace schema into every consumer of
 * `@blaster/core/twenty/api`, which is exactly what keeping the generated
 * client on its own `./twenty/api/generated` subpath exists to avoid. The
 * caller imports `createClient` from there, so the types arrive only where
 * someone is actually writing a query.
 */

import { authorizedFetch } from "./session.ts";
import type { SessionStore, TokenRefresher } from "../types.ts";

/** The shape `twenty-client-sdk`'s generated `createClient` satisfies. */
export type GeneratedClientFactory = (options: { url: string; fetch: typeof fetch }) => unknown;

export interface TwentyClientOptions<TFactory extends GeneratedClientFactory> {
  graphqlUrl: string;
  createClient: TFactory;
  loadSession: SessionStore["load"];
  saveSession: SessionStore["save"];
  clearSession: SessionStore["clear"];
  refreshTokens: TokenRefresher;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

/** Bind a session store to the generated client. One call per surface. */
export function createTwentyClient<TFactory extends GeneratedClientFactory>(
  options: TwentyClientOptions<TFactory>,
): ReturnType<TFactory> {
  return options.createClient({
    url: options.graphqlUrl,
    fetch: authorizedFetch({
      loadSession: options.loadSession,
      saveSession: options.saveSession,
      clearSession: options.clearSession,
      refreshTokens: options.refreshTokens,
      fetchFn: options.fetchFn,
      nowMs: options.nowMs,
    }),
  }) as ReturnType<TFactory>;
}
