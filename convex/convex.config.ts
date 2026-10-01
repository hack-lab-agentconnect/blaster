import { defineApp } from "convex/server";
import { v } from "convex/values";
import agent from "@convex-dev/agent/convex.config";
import rateLimiter from "@convex-dev/rate-limiter/convex.config";

/**
 * Blaster's Convex app.
 *
 * Two components are mounted:
 *   - agent, which owns conversation threads and message history. One thread
 *     per sequence enrollment (keyed by Twenty recipient id) holds the linear
 *     SMS history; see convex/threads.ts for the app-side wrappers.
 *   - rateLimiter, which caps outbound Telnyx throughput. The limits and why
 *     each one exists are in convex/rateLimit.ts; the component is mounted here
 *     because that is where its tables live.
 *
 * Previously mounted here were `@agentmail/convex`, `@listeningkit/telnyx`,
 * and `@listeningkit/treg`, but those packages are private and were never
 * installed, so the mounts were removed to unblock `convex dev`. If access
 * is granted later, re-add each package to dependencies and restore its
 * `app.use(...)` line. Webhook signature verification currently lives in the
 * Hono API (`apps/api/src/index.ts`) until the telnyx component returns.
 *
 * Components rather than hand-rolled clients so the provider state lives in
 * the database, survives a redeploy, and is queryable.
 *
 * The declared `env` is what makes `_generated/server`'s `env` object typed, so
 * `env.TELNYX_API_KEY` is a `string` and a typo in the name is a build error
 * rather than a runtime `undefined`. Declaring it here does not set it: the
 * value still has to be provisioned on the deployment, and `config/env-vars.json`
 * stays the single list of what the repo expects to exist.
 */
const app = defineApp({
  env: {
    TELNYX_API_KEY: v.string(),
    // The enroll seam reads Twenty from Convex (over `agencyProspects`), so the
    // deployment needs the same two credentials the Hono surface uses. Declared
    // here so `env.TWENTY_*` is typed; provisioned like any other variable.
    TWENTY_BASE_URL: v.optional(v.string()),
    TWENTY_API_KEY: v.optional(v.string()),
  },
});

app.use(agent);
app.use(rateLimiter);

export default app;
