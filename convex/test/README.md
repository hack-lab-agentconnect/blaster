# Convex integration tests

Tests here run the real Convex functions — schema validation, indexes, and
transaction semantics included — against an in-memory backend via `convex-test`.
They are the only tests that can catch the class of defect this codebase has
actually shipped:

- `campaignFor` matched `sequence.fromNumber` and left every pool-backed thread
  `unassigned`.
- `consumeSender` re-selected instead of reserving the number the runner had
  already evaluated eligibility and claimed capacity for.
- `loadRunContext` built its conversation pair key from the peer twice, so
  `hasReplied` was always false.
- `compact()` renumbered pool memberships without moving `pools.cursor`.

None of those is visible to a pure `packages/core` unit test; each needed a
database. `packages/core` tests still carry the pure arithmetic (selection,
cursor math), and those stay where they are.

## Running

`pnpm test` picks these up (the include glob in `vitest.config.ts` lists
`convex/test/**`). A single file:

```
node_modules/.bin/vitest run convex/test/pool.test.ts
```

## The harness

`harness.ts` builds a `convexTest(schema)` instance and exposes the seed helpers
the tests share, so a test reads as the scenario it describes rather than as a
pile of inserts. It never talks to a deployment: `convex-test` runs the functions
in-process, so no `CONVEX_URL` and no credentials are needed.
