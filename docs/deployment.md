# Deployment

Push to `main` deploys to production. The Vercel git integration builds
the pushed commit and moves the `blaster-web-nine.vercel.app` alias onto
it when the build is Ready. No CLI step and no dashboard click.
`vercel --prod` from a checkout builds the same tree by hand; it is the
rollback path, not the normal path.

## What a build does

`buildCommand` in `vercel.json` runs two steps. First the web SPA, then
`node scripts/build-api-function.mjs`, which esbuild-bundles the Hono API
into `api/_bundle.js` and copies `config/env-vars.json` beside it for the
runtime manifest read. The deployment is the static `apps/web/dist` plus
one serverless function; the rewrite table sends every `/api/*` path to
it.

`vercel.json` is the single source of truth for the build. The dashboard
kept a stale web-only build command with no bundling step; it has been
cleared, and the file wins where the two disagree.

## The tracked-shim rule

Vercel detects function candidates from pre-build source. A bundle
generated mid-build is never attached to the lambda: the build log shows
the bundle bytes, the deployment reads Ready, and every `/api` route
answers 404 anyway, anonymous and owner-authed alike. The only candidate
must therefore exist in git. `api/handler.js` is a tracked three-line
shim re-exporting the bundle, and the bundle itself lives at the
underscore-prefixed `api/_bundle.js` so zero-config detection never sees
it twice. Vercel's builder traces the shim's import after the build step
has written the bundle.

Never commit the bundle, never ignore the shim, and never rename either
without updating `scripts/build-api-function.mjs` and this page together.

## Failure modes seen

| Symptom | Meaning | Fix |
| --- | --- | --- |
| Ready, web shell serves, every `/api` route 404s | No function attached: the deployment's lambda output list is empty | Read the build log for the `bundled api/_bundle.js` line, confirm the shim is still tracked, then roll back with `vercel promote <last-good-url>` |
| Build Errors on a git push | The build itself failed | Read the build log, fix, push again |
| Direct `blaster-*.vercel.app` URL shows a Vercel login page | SSO protection covers hashed URLs; the app is fine | Use the production alias, or open it signed into a Vercel account |

## Rollback

`vercel promote <deployment-url>` moves the production alias onto a
known-good build without rebuilding. Confirm with
`/api/auth/config` (200 with the production client id) and `/health`.

## vercel.json discipline

`vercel.json` must stay valid JSON. A `//` comment once made Vercel
ignore the file, silently dropping `buildCommand` and shipping a
function-less static build. No comments in that file, ever.
