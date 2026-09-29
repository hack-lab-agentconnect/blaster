import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/*/test exists for the Hono surface: the API owns the OAuth
    // provider's construction (including the auth-guard credentials), and a
    // wiring bug there is invisible to a core-only test.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    environment: "node",
  },
});
