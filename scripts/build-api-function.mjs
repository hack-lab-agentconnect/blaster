/**
 * Bundle the API into the single file Vercel runs.
 *
 * The builder's own file tracing does not work here, and it is worth saying why
 * rather than just working around it. This repository imports with explicit `.ts`
 * specifiers throughout, which is correct for a workspace that runs from source
 * with tsx and type-checks with `noEmit`. Vercel compiles `api/index.ts` to
 * `api/index.js` and then traces relative imports to decide what to copy into
 * the function bundle; a specifier that ends in `.ts` does not resolve against
 * the compiled `.js`, so the app source is neither bundled nor copied and the
 * function dies at import time with `ERR_MODULE_NOT_FOUND`.
 *
 * Bundling explicitly is the honest fix. One esbuild pass produces one file that
 * contains the API and the core packages it imports, leaves `node_modules`
 * external so the platform's own dependency handling still applies, and removes
 * the reliance on tracing a tree that is not laid out for it. It also gives the
 * deploy a real build step, so a type or import mistake fails here rather than
 * in production.
 *
 * The output is generated and gitignored; `api/index.ts` stays the source.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The entry is underscore-prefixed on purpose: Vercel treats every file
// under api/ as a function candidate, and a bare `index.ts` next to the
// bundle made two builders fight over the route (the tracer chokes on this
// repo's explicit `.ts` specifiers and the route silently vanished from some
// builds while working in others). The underscore keeps zero-config
// detection off the source so `handler.js` is the only candidate, on every
// toolchain version. `handler.js` cannot collide with `_entry.ts` the way
// `index.js` would have with `index.ts`.
const OUTFILE = "api/handler.js";

const result = await build({
  entryPoints: ["api/_entry.ts"],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  // Node 22 is the floor for the `@vercel/node` runtime used below, and the
  // syntax the API is written to is well inside it.
  target: "node22",
  format: "esm",
  sourcemap: true,
  // Everything is bundled, dependencies included, and only Node's own builtins
  // stay external. A serverless function has no node_modules of its own beyond
  // what the platform installs for it, and this repository's runtime
  // dependencies are declared by `apps/api` and `packages/core` rather than at
  // the root, so leaving them external produced a bundle that imported
  // `@hono/node-server` from a directory that does not contain it. Node builtins
  // are excluded automatically when platform is `node`.
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs).reduce((total, out) => total + out.bytes, 0);
console.log(`bundled ${OUTFILE} (${(bytes / 1024).toFixed(0)} kB) for the @vercel/node runtime`);

/**
 * Put the env manifest next to the bundle.
 *
 * `missingRequired()` reads `config/env-vars.json` from disk at runtime, walking
 * up from its own module directory, because locally that file is the contract the
 * API, Convex and the docs all share. A bundle cannot carry it: esbuild inlines
 * imports, not a path a function opens while serving, so the deployed function
 * died with `config/env-vars.json not found` and `/health` answered 500.
 *
 * Copying it beside the bundle is what the walk finds first, and it keeps the
 * manifest a single source of truth rather than a second copy to keep in step.
 * Generated output, so it is gitignored alongside the bundle.
 */
const manifestSource = "config/env-vars.json";
const manifestTarget = "api/config/env-vars.json";
mkdirSync(dirname(manifestTarget), { recursive: true });
copyFileSync(manifestSource, manifestTarget);
console.log(`copied ${manifestSource} -> ${manifestTarget} for the runtime manifest read`);
