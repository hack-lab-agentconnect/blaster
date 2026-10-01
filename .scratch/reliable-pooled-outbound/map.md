# Wayfinder map: Reliable pooled outbound

<!-- wayfinder:map -->

## Destination

A sequencer that sends reliably from a number pool: a prospect texted from any
pool number has one thread that resolves to the right campaign, a reply or a STOP
stops every sequence for that person on every number, and no send can outrun
either the deployment's send rate limiter or a number's own rate budget. Reaching
this means the pool is the sending unit end to end — runner, persistence, inbox,
and all three surfaces — and the decisions are made, not just the code written.

## Notes

- Domain: the Blaster backend. Where things live is in
  [docs/architecture.md](../../docs/architecture.md); the Convex tree's rules are
  in [docs/convex-naming-conventions.md](../../docs/convex-naming-conventions.md);
  the repo's own conventions in
  [docs/naming-conventions.md](../../docs/naming-conventions.md).
- The current pool implementation is on branch `jilly-pool-domain`:
  [docs/pools.md](../../docs/pools.md) is the as-built reference, including the
  two known inbound gaps this map must close.
- The project's goal, as stated in the docs: read `README.md`, `docs/send.md`,
  and `docs/sequencer.md` before choosing a ticket. Do not re-derive the
  objective; it is written down.
- Every session: call the Skill tool twice, for "grilling" and "domain-modeling".
- Preferences: decisions are recorded, not deliverables (plan, don't do), except
  a ticket that is tagged `task`. Keep the pre-push `goal.md` gate satisfied.

## Decisions so far

<!-- the index: one line per closed ticket, enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [Suppression model](issues/01-suppression-model.md): a durable per-person `suppressions` row keyed on the E.164 peer, written by the inbound STOP only, additive over `opted-out`, checked at enroll and at send, lifted only by an explicit human resolve.
- [A Convex integration-test harness](issues/04-convex-test-harness.md): `convex/test/` runs the real functions against the real schema, holding the fixes for pool cursor/TOCTOU, campaignFor, and suppression.
- [Thread identity under rotation](issues/02-thread-identity.md): keep the per-number threads as storage; the inbox gains a person-level grouping, and person-level facts (reply, STOP, suppression) are already peer-wide.
- [Limiter and pool budget relationship](issues/03-limiter-pool-relationship.md): the rate limiter is the hard ceiling, the pool paces at or under it, the period has one source, and disagreement resolves by refusing, never by sending.
## Not yet specified

<!-- in-scope fog: can be sensed, not yet sharp enough to ticket -->

- **How a pool number's local send window and quiet hours compose with the
  pool's own pacing.** The runner already has quiet-hours logic for a fixed
  number; where a pool number's jurisdiction/time-zone enters selection is not
  yet a sharp question.
- **What happens to in-flight enrollments when a pool is paused or emptied while
  the runner is mid-queue.** Partly touched by `pool-empty` parking, but the
  wider operator story (draining, resume) is fog.
- **How the account send limiter and the per-number pool budget should be
  configured together** — is the pool's `minSpacingMs` always derived from the
  limiter's period, or can an operator run a pool slower than the ceiling on
  purpose, and what does the API expose.
- **Whether pool assignment belongs on the sequence at all**, or a pool should be
  a first-class sender that many sequences share by reference.
- **Observability**: what a "pool status" view must show an operator to trust the
  pool (throughput, cooling numbers, how close to the ceiling), beyond the rollup
  fields that exist.

## Out of scope

<!-- work beyond the destination; closed, never graduates -->

- Inbound email and call-recording pipelines: unrelated to pooled SMS sending.
- The Twenty CRM integration surface and OAuth: a dependency, not this effort.
- Reworking the prospect discovery / `treg` component: not on the pooled-send
  route.
