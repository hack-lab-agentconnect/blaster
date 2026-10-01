/**
 * Tracked Vercel function entry. The app itself lives in
 * `apps/api/src/index.ts` (see `_entry.ts`); the code that runs here is the
 * esbuild bundle beside this file, rebuilt on every deploy by
 * `scripts/build-api-function.mjs`.
 *
 * This file must be tracked in git: Vercel detects function candidates from
 * pre-build source, so a bundle generated mid-build is never attached to
 * the lambda (git-triggered builds shipped with an empty function and
 * answered 404 on every /api route, while CLI uploads carrying a local
 * bundle worked). The underscore on `_bundle.js` keeps zero-config
 * detection off the generated file, so this shim is the only candidate;
 * Vercel's builder traces this import after the build step has written it.
 */
import app from "./_bundle.js";

export default app;
