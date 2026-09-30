/**
 * Twenty's object metadata, as the naming convention spells it.
 *
 * `objectService` is a mirror, not a repo-owned name: it is Twenty's own name
 * for the surface that answers "what objects exist in this workspace", and the
 * camelCase directory is deliberate. See docs/naming-conventions.md, "the
 * external system wins".
 *
 * The reason it is its own module rather than a method on the REST client is
 * that it is a different transport with a different credential. `TwentyClient`
 * authenticates with the workspace API key and speaks `/rest` plus `/graphql`.
 * Object metadata is served by Twenty's `/metadata` endpoint and rejects the API
 * key outright ("Missing authentication token"), so it needs an OAuth bearer.
 * Folding it into the REST client is what left `TwentyClient.hasObject` asking
 * `/graphql` for an `objects` field the root Query does not have, which is a
 * guaranteed failure rather than a subtle one.
 */

/** One object in the workspace, as Twenty's metadata endpoint reports it. */
export interface TwentyObjectSummary {
  /** Twenty's nameSingular, e.g. `agencyPhone`. This is what a module mirrors. */
  nameSingular: string;
  /** Twenty's namePlural, e.g. `agencyPhones`. This is the REST resource name. */
  namePlural: string;
  id?: string;
}

export interface ListObjectsOptions {
  /** The Twenty base URL, e.g. https://twenty.example.com */
  baseUrl: string;
  /** An OAuth bearer for the metadata endpoint. The API key does not work here. */
  token: string;
  /** The auth-guard credentials, when the instance sits behind one. */
  basicAuth?: { user: string; password: string } | null;
  /** Page size. Twenty's own metadata list pages; the default reads one page. */
  first?: number;
}
