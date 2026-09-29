/**
 * The Vercel function entry.
 *
 * The Hono app itself lives in `apps/api/src/index.ts` and is already written to
 * be importable: it only binds a port when it is the process entry point, so
 * importing it here hands over the routing without starting a listener. That is
 * what lets the same app serve `pnpm dev` locally and a serverless function in
 * production, instead of a second copy of the routes that would drift.
 *
 * Vercel's Node runtime accepts a default export with a `fetch` method, which is
 * the shape Hono already exposes.
 */

import app from "../apps/api/src/index.ts";

export default app;
