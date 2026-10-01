# Limiter and pool budget relationship

Type: grilling
Status: resolved
Blocked by:

## Question

Two rate authorities now gate a send: `convex/rateLimit.ts` (`telnyxSend` account
ceiling and `telnyxSendPerNumber` token bucket) admits, and the pool's
`minSpacingMs`/`dailyCapPerNumber` paces. The pool's default spacing is derived
from the limiter's per-number period.

Decide the contract: is the limiter always the hard ceiling and the pool always
at-or-under it (one is derived, one is configured)? May an operator run a pool
slower than the ceiling deliberately, and if so is `minSpacingMs` independent
rather than derived? And when the two disagree, which is authoritative at the API
level. The answer fixes what `createPool` accepts and what the docs promise.

## Answer

Decision: **the send rate limiter is the hard ceiling; the pool is the selection
and pacing authority that must sit at or under it. The pool's spacing is derived
from the limiter's period by default, and an operator may set it slower but never
faster than the bucket's refill.**

The contract, in three parts:

1. **Admission vs selection.** `convex/rateLimit.ts` decides *whether* a send may
   happen at all (account ceiling + per-number bucket); the pool decides *which*
   number and paces within that. This is already the implemented shape: the
   runner claims capacity for the pool-chosen number, then reserves the pool
   budget, then claims the step. The decision fixes that as the contract rather
   than an accident of ordering.

2. **One source for the period.** `DEFAULT_MIN_SPACING_MS` is
   `TELNYX_PER_NUMBER_PERIOD_MS` (1s), so a pool created with no explicit spacing
   paces exactly at the bucket's refill. A pool faster than that would only earn
   refusals, so `minSpacingMs` below the period is meaningless and is treated as
   the period. A pool *slower* than the period is allowed and is the operator's
   deliberate throttle (e.g. a warmed number).

3. **Disagreement is resolved by refusing, never by sending.** When the limiter
   refuses, the runner defers (`send-capacity-exhausted`); when the pool has no
   member, it defers (`pool-rate-limited`). Neither path sends past a limit, so
   the limiter never has to "win" a race — it is simply asked first.

Consequences:
- `createPool` clamps `minSpacingMs` to `max(requested, TELNYX_PER_NUMBER_PERIOD_MS)`
  rather than accepting a value below the bucket period, and records that the
  floor is the limiter's. (A follow-up code change; the value today is only
  defaulted, not clamped.)
- `docs/pools.md` states the relationship as the contract, which it now does
  ("The pool and the send rate limiter").

Ruled out: making the pool the ceiling (it is per-number, not account-wide, so it
cannot see the account limit), and letting an operator set a pool faster than the
bucket (that is a footgun that produces parked enrollments, which the codebase's
own error handling makes non-retryable).
