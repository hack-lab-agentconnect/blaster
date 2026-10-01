# Goal

<!-- goal
updated: 2026-10-01T18:11:17Z
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
- docs/agents/domain.md
- docs/agents/issue-tracker.md
- docs/agents/triage-labels.md
- .scratch/reliable-pooled-outbound/map.md
- .scratch/reliable-pooled-outbound/issues/01-suppression-model.md
- .scratch/reliable-pooled-outbound/issues/02-thread-identity.md
- .scratch/reliable-pooled-outbound/issues/03-limiter-pool-relationship.md
- .scratch/reliable-pooled-outbound/issues/04-convex-test-harness.md
- .scratch/reliable-pooled-outbound/issues/05-open-the-pr.md
- AGENTS.md
- CLAUDE.md
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
- [x] Wayfinder map charted at `.scratch/reliable-pooled-outbound/` (destination, fog, decisions, tickets)
- [x] Suppression model decided (ticket 01): a durable per-person `suppressions` row keyed on the E.164 peer, written by inbound STOP only, checked at enroll and send, lifted by an explicit human resolve
- [ ] Durable per-peer suppression: implement the decided `suppressions` model in Convex
- [ ] Decide how a contact reached from several pool numbers appears in the inbox (ticket 02, thread identity under rotation)
- [ ] Decide the limiter/pool budget contract (ticket 03)
- [ ] Add a `convex-test` harness so `campaignFor`, `consumeSender`, and `stopEnrollmentsForPeer` have real integration tests (ticket 04, blocked by 01 and 02)
- [ ] Open the PR and get the pool branch merged to `main` (ticket 05)
