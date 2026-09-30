import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/*/test exists for the Hono surface: the API owns the OAuth
    // provider's construction (including the auth-guard credentials), and a
    // wiring bug there is invisible to a core-only test.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
    // Those route tests spend nearly all of their time in
    // `await import("../src/index.ts")` — building the whole Hono app and the
    // core barrel behind it — rather than in the request. The default 5s was
    // close enough to the real cost that a loaded machine (the pre-push hook
    // runs the tests straight after a typecheck) tipped a few of them over,
    // which reads as a flaky failure and is not one. This is a ceiling for
    // transform and import time, not a latency budget: every assertion here is
    // on a response status or a body, never on how long it took.
    testTimeout: 15_000,
  },
});
