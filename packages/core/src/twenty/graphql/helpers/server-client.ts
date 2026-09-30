/**
 * The generated client, bound to the server's workspace key.
 *
 * `createTwentyClient` in ./client.ts is for whoever holds an operator's OAuth
 * session. This is the other half: the API, the CLI in a scripted context, and
 * Convex actions authenticate as the *workspace* with TWENTY_API_KEY, which is a
 * bearer token, not an operator session.
 *
 * Basic auth is deliberately not applied here. The guard in front of a
 * self-hosted Twenty normally exempts /rest and /graphql so record reads work
 * with the bearer token alone, and the two cannot be combined: both are the
 * Authorization header. A guard that does not exempt the record paths needs a
 * different mechanism, not a second Authorization value. The guard is handled
 * where it actually applies, on the OAuth endpoints, in
 * twenty/oauth/helpers/basic-auth.ts.
 */

import { createClient } from "../generated/index.ts";
import type { Client } from "../generated/index.ts";
import type { BasicCredentials } from "../../oauth/helpers/basic-auth.ts";

/** `https://host` plus a path, with exactly one slash between them. */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface ServerClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Accepted and ignored on purpose; see the note above. */
  basicAuth?: BasicCredentials | null;
  fetchFn?: typeof fetch;
  headers?: Record<string, string>;
}

/**
 * The typed workspace client. Throws rather than returning a half-built client
 * when the key is missing, because a request made without a bearer token comes
 * back as a 401 that looks like a permissions problem instead of a missing
 * variable.
 */
export function createServerTwentyClient(options: ServerClientOptions): Client {
  if (!options.baseUrl || !options.apiKey) {
    throw new Error("TWENTY_BASE_URL and TWENTY_API_KEY are required for the Twenty GraphQL client");
  }
  return createClient({
    url: joinUrl(options.baseUrl, "graphql"),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...(options.fetchFn ? { fetch: options.fetchFn } : {}),
  });
}
