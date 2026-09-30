/**
 * Shared Twenty API shapes.
 *
 * Sessions carry OAuth tokens (see the `twenty/oauth` domain); the API
 * client never sees passwords or API keys. Surfaces own their own stores
 * (CLI file, browser storage, Convex env) and hand this domain load/save
 * callbacks, so token handling is identical everywhere.
 */

import type { TokenSet } from "../oauth/helpers/oauth.ts";

/** An OAuth session against the Twenty workspace. */
export interface TwentySession {
  tokens: TokenSet;
  obtainedAtMs: number;
}

/** Surface-owned token store. Sync or async; the client awaits either. */
export interface SessionStore {
  load: () => TwentySession | null | Promise<TwentySession | null>;
  save: (session: TwentySession) => void | Promise<void>;
  clear: () => void | Promise<void>;
}

/** Mint a fresh TokenSet from a refresh token. Wired to `refreshAccessToken` by the caller. */
export type TokenRefresher = (refreshToken: string) => Promise<TokenSet>;

/** A GraphQL error entry, as Twenty returns it inside a 200 payload. */
export interface GraphqlErrorEntry {
  message?: string;
  extensions?: { code?: string };
}
