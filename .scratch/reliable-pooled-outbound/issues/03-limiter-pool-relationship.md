# Limiter and pool budget relationship

Type: grilling
Status: open
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
