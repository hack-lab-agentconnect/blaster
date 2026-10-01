# A Convex integration-test harness

Type: prototype
Status: open
Blocked by: 01, 02

## Question

All 544 tests are pure `packages/core` unit tests. The defects that have actually
bitten this work — `campaignFor` matching the wrong number, `consumeSender`
re-selecting, `loadRunContext` building a pair key from the peer twice,
`compact()` leaving the cursor behind — all live in Convex functions and none has
a regression test. Make the smallest concrete thing that runs those mutations and
queries against a real Convex runtime (`convex-test`), and show one failing test
turned green, so the harness's shape can be judged before it is adopted.
