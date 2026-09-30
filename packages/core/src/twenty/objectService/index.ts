/**
 * Twenty's object-metadata surface, in one place.
 *
 * The I/O lives here rather than in `helpers/` because the rule is that
 * `helpers/` holds pure functions only: this module performs the network call,
 * and the parsing it delegates is pure.
 *
 * The credential is an OAuth bearer, not the workspace API key. Twenty serves
 * object metadata from `/metadata`, and that endpoint answers the API key with
 * "Missing authentication token"; `TwentyClient` is authenticated with the API
 * key and therefore cannot answer this question.
 */

import { parseObjects } from "./helpers/index.ts";
import type { ListObjectsOptions, TwentyObjectSummary } from "./types.ts";

export type { ListObjectsOptions, TwentyObjectSummary } from "./types.ts";
export { hasObject, parseObjects } from "./helpers/index.ts";

const QUERY = `query { objects(paging: { first: %d }) { edges { node { id nameSingular namePlural } } } }`;

/** A failure carrying the status, so a caller can tell 401 from a 404. */
export class TwentyMetadataError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Twenty metadata ${status}: ${detail}`);
    this.name = "TwentyMetadataError";
    this.status = status;
  }
}

/**
 * List the objects this workspace defines.
 *
 * Throws `TwentyMetadataError` on a non-2xx, rather than returning an empty
 * list: an unauthenticated caller must not be able to mistake "I could not
 * check" for "this workspace has no custom objects", because that answer would
 * silently change which modules exist.
 */
export async function listObjects(options: ListObjectsOptions): Promise<TwentyObjectSummary[]> {
  const base = options.baseUrl.replace(/\/+$/, "");
  const first = options.first ?? 200;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.token}`,
  };
  // Blaster's Twenty sits behind an auth guard, so the metadata call carries the
  // guard credentials too, the same way the OAuth provider does.
  if (options.basicAuth?.user && options.basicAuth?.password) {
    const encoded = Buffer.from(`${options.basicAuth.user}:${options.basicAuth.password}`).toString("base64");
    headers["X-Twenty-Basic-Auth"] = encoded;
  }

  const response = await fetch(`${base}/metadata`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: QUERY.replace("%d", String(first)) }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => `status ${response.status}`)).slice(0, 300);
    throw new TwentyMetadataError(response.status, detail);
  }
  const body = (await response.json()) as { data?: unknown; errors?: unknown[] };
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new TwentyMetadataError(422, JSON.stringify(body.errors).slice(0, 300));
  }
  return parseObjects(body.data);
}
