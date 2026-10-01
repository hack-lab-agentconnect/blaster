# A Convex integration-test harness

Type: prototype
Status: resolved
Blocked by: 01, 02

## Question

All 544 tests are pure `packages/core` unit tests. The defects that have actually
bitten this work — `campaignFor` matching the wrong number, `consumeSender`
re-selecting, `loadRunContext` building a pair key from the peer twice,
`compact()` leaving the cursor behind — all live in Convex functions and none has
a regression test. Make the smallest concrete thing that runs those mutations and
queries against a real Convex runtime (`convex-test`), and show one failing test
turned green, so the harness's shape can be judged before it is adopted.

## Answer

A `convex-test` harness is in place at `convex/test/`, running the real functions
against the real schema in-process (no deployment, no credentials). It caught
nothing new, but it now *holds* the fixes that shipped silently:

- `harness.ts` seeds rows the tests share; `refs.ts` gives typed
  `makeFunctionReference`s so a test cannot assert on a `never` cast.
- `pool.test.ts`: `removeNumber` moves the cursor with the survivors and
  `reorderNumbers` repoints it; `consumeSender` reserves the proposed order and
  refuses rather than substituting a different number.
- `conversations.test.ts`: `campaignFor` attributes pool-backed threads;
  `recordInboundMessage` stops peer-wide, dedupes a redelivery, and stops harder
  on an opt-out.
- `suppressions.test.ts`: the full suppression lifecycle.

`vitest.config.ts` includes `convex/test`, and `check-convex` exempts that tree
from the camelCase filename rule. This closes the gap that let four defects reach
the branch unproven: there is now a place where a Convex-function regression
fails a test.
