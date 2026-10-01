# Goal

<!-- goal
updated: 2026-10-01T16:37:28Z
commit: goal: scope the pool objective and gate pushes on a fresh outline
-->

The running scope for the number-pool objective. `scripts/check-goal.mjs` refuses
a push unless this file is a current outline — updated within 20 minutes, naming
the commit message, the files changed, and the task list. Refresh it with
`node scripts/check-goal.mjs --stamp` right before pushing.

## Objective

A number pool is the outbound sending unit: a sequence works a pool in order,
inside each number's rate budget and the deployment's send rate limiter, and the
inbox, the API, the MCP server, and the CLI all reflect what the pool actually
did. The work is complete when a prospect texted from a pool number has a thread
that resolves to its campaign, replies stop the sequence, and no send can outrun
the per-number or account ceiling.

## Files changed

- goal.md
- README.md
- apps/api/src/index.ts
- apps/api/src/lib/convex/helpers/client.ts
- apps/api/src/lib/convex/index.ts
- apps/api/src/lib/convex/types.ts
- apps/api/test/telnyx-webhook.test.ts
- convex/_generated/api.d.ts
- convex/conversations/model.ts
- convex/phoneNumbers/model.ts
- convex/pool/helpers.ts
- convex/pool/index.ts
- convex/pool/model.ts
- convex/pool/mutations.ts
- convex/pool/queries.ts
- convex/pool/types.ts
- convex/pool/utils.ts
- convex/rateLimit.ts
- convex/schema.ts
- convex/schema/pool.ts
- convex/schema/sequences.ts
- convex/sequence/actions.ts
- convex/sequence/helpers.ts
- convex/sequence/mutations.ts
- convex/sequence/types.ts
- docs/README.md
- docs/architecture.md
- docs/convex-naming-conventions.md
- docs/pools.md
- docs/sequencer.md
- lefthook.yml
- package.json
- packages/blaster-cli/src/cli/index.ts
- packages/blaster-cli/src/cli/pools.ts
- packages/blaster-cli/src/cli/prompt.ts
- packages/blaster-mcp/src/mcp/index.ts
- packages/core/src/blaster/api/helpers/client.ts
- packages/core/src/blaster/api/types.ts
- packages/core/src/index.ts
- packages/core/src/pipeline/pool/helpers/index.ts
- packages/core/src/pipeline/pool/helpers/select.ts
- packages/core/src/pipeline/pool/index.ts
- packages/core/src/pipeline/pool/types.ts
- packages/core/test/pool.test.ts
- packages/core/test/telnyx-ownership.test.ts
- scripts/check-goal.mjs
- scripts/check-surfaces.mjs

## Task

- [x] `convex/pool/` domain: the `poolNumbers` relation, per-number rate state, internal `consumeSender`, cursor remap
- [x] `packages/core/src/pipeline/pool/`: pure selection and cursor math, unit-tested
- [x] Sequencer runner: sender chosen from the pool, capacity claimed before the step claim, deferrals retry
- [x] Reconcile with `main`'s send rate limiter: pool paces, `convex/rateLimit.ts` admits, one source for the period
- [x] API routes, MCP tools, CLI commands, and the interactive `blaster pool` wizard (login gate via `ensureLiveSession`)
- [x] Capability registry kept honest by the new `scripts/check-surfaces.mjs` gate
- [x] `campaignFor` attributes pool-backed threads; TOCTOU closed by reserving the proposed order
- [x] Inbound ownership reads the Convex ledger; the reply re-check is peer-wide
- [x] `docs/pools.md` describes the relation, rates, surfaces, and the inbound path
- [ ] Durable per-peer suppression: write an opt-out to a `suppressions` table keyed on E.164, checked at enroll and at send (currently opt-out is per-enrollment only)
- [ ] Decide how a contact reached from several pool numbers appears in the inbox (one thread per number today)
- [ ] Add a `convex-test` harness so `campaignFor`, `consumeSender`, and `stopEnrollmentsForPeer` have real integration tests
- [ ] Open the PR and get the pool branch merged to `main`
