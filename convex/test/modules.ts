/**
 * The module map `convex-test` loads.
 *
 * `convexTest` needs a map of every function module keyed by its path; without
 * one it relies on a relative `import.meta.glob` that only works when the test
 * sits at a particular depth. Providing it explicitly keeps the harness
 * location-independent, and it must include `_generated` (convex-test derives
 * the module root from it).
 *
 * `eager: false` matches what `convex-test` expects: it awaits each module's
 * loader when a function is invoked, so only the modules a test actually calls
 * are imported.
 */
export const modules = import.meta.glob("../**/*.{ts,js}");
