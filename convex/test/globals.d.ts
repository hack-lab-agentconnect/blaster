/**
 * The one ambient declaration the Convex test tree needs.
 *
 * `modules.ts` uses Vite's `import.meta.glob` to build the module map
 * `convex-test` loads. Vite (the bundler behind vitest) provides that at
 * runtime, but its client types are not a dependency of this package, so the
 * shape is declared here rather than pulling Vite's types into the Convex
 * typecheck. Keep this to exactly what is used.
 */
interface ImportMeta {
  glob(
    pattern: string,
  ): Record<string, () => Promise<Record<string, unknown>>>;
}
