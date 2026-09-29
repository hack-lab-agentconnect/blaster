import { defineApp } from "convex/server";
import agent from "@convex-dev/agent/convex.config";

/**
 * Blaster's Convex app.
 *
 * One component is mounted:
 *   - agent, which owns conversation threads and message history. One thread
 *     per sequence enrollment (keyed by Twenty recipient id) holds the linear
 *     SMS history; see convex/threads.ts for the app-side wrappers.
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
 */
const app = defineApp();

app.use(agent);

export default app;
