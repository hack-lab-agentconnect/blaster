/**
 * Twenty GraphQL, and the sessions it authenticates with.
 *
 * A mirror of the transport, not of an object, so the name is Twenty's own term
 * for it and stays kebab-case: it is not a `nameSingular` and is not on the
 * allowlist in `config/twenty-objects.json`.
 *
 * Two ways in, and the difference is who is authenticating:
 *
 *   - `createServerTwentyClient` — the workspace, via `TWENTY_API_KEY`. This is
 *     what the API, a scripted CLI, and Convex actions use.
 *   - `createTwentyClient` — one signed-in operator, via that surface's OAuth
 *     session, refreshing on expiry.
 *
 * The sibling `open-twenty-dialer` repo has a `twentyGraphqlClient()` here that
 * takes no arguments and reads the environment directly. It is deliberately not
 * copied: it is the same construction as `createServerTwentyClient`, which takes
 * its configuration as an argument so a test can supply its own and so a
 * deployment's base URL is never read out of a global. Two names for one
 * construction is how the two drift apart.
 *
 * The generated client is deliberately not re-exported here. It is a print of the
 * whole workspace schema and runs to megabytes, and it lives on its own
 * `./twenty/graphql/generated` subpath precisely so a consumer that does not
 * write a query does not pay for it.
 */

export * from "./helpers/index.ts";
export * from "./types.ts";
