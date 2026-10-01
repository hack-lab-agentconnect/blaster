# Number pools

A pool is an ordered group of sending numbers worked one at a time, each inside
its own rate budget. Assigning a pool to a sequence makes the pool, not a fixed
`fromNumber`, decide which number sends each message. This page is written to
match the code: the tables, the selection rule, the status fields, and the four
surfaces that manage it.

## Why a pool exists

A carrier rate limit is scoped to a number. When a runner ignores that and keeps
handing one number more than it may send, the extra messages are pushed into the
carrier's limit queue rather than sent. The pool exists to make that impossible:
it sends only what a number's budget allows now and defers the rest to the
instant the pool is next able to send. Adding capacity is adding numbers, not
changing a sequence.

## The relationship

Two tables, in `convex/schema/pool.ts`:

```
poolNumbers (the relation)          pools
- poolId  ---------------> id (pools)
- phoneNumberId ---------> phoneNumbers.id
- phoneNumber      (E.164, denormalised)
- order            (sequential position)
- status           active | paused | removed
- sentToday
- dayStartedAt
- nextAvailableAt
- lastSentAt
- assignedAt
- removedAt
                                    - status            active | paused
                                    - strategy          sequential
                                    - cursor            last-used order
                                    - minSpacingMs
                                    - dailyCapPerNumber
                                    - activeNumberCount (rollup)
                                    - nextAvailableAt   (rollup)
                                    - lastDispatchedAt
```

A number is related to a pool through a `poolNumbers` row, not a `poolId` field
on `phoneNumbers`. That is deliberate: a membership has an `order` and its own
rate state, and a number can sit in more than one pool. The phone's identity and
purchase ledger stay on `phoneNumbers`; the pool owns membership, order, and
runtime state.

**The relational status is the `poolNumbers` row.** `status`, `sentToday`,
`dayStartedAt`, and `nextAvailableAt` are the fields that answer "what is this
number doing right now". The matching fields on `pools` are the rollup so a
status view is one read: `activeNumberCount` is how many members can send, and
`nextAvailableAt` is the earliest instant any of them can.

## The selection rule

`selectSender` in `packages/core/src/pipeline/pool/helpers/select.ts` is a pure
function, so the arithmetic is tested with no database:

- Start after `pools.cursor` and walk the active members in `order`, wrapping.
- A member may send when `nextAvailableAt <= now` and, if `dailyCapPerNumber > 0`,
  `sentToday < dailyCapPerNumber`.
- The first member that may send wins. If none may, the function returns the
  **soonest** instant any active member becomes available.

The runner uses this twice:

1. **Before claiming a step** it reads `availableSender` (no budget spent). If
   none may send now, it defers the enrollment to `soonestNextAvailableAt` with
   `lastSkipReason: "pool-rate-limited"`. If the pool has no active numbers at
   all it parks the enrollment `awaiting-human` with `lastSkipReason:
   "pool-empty"`. Neither case sends and neither drops the message.
2. **After it owns the claim**, it calls the internal `consumeSender` mutation,
   which re-selects and spends the number's budget in one transaction: it
   increments `sentToday`, sets `nextAvailableAt = now + minSpacingMs`, advances
   `pools.cursor`, and refreshes the rollup. Two runners cannot both spend the
   last unit of one number's allowance.

## Managing a pool from a surface

Every pool capability exists on all three surfaces, and they all resolve to the
same Convex functions. The capabilities are registered in
`packages/blaster-cli/src/cli/index.ts` (`CAPABILITIES`), and
`scripts/check-surfaces.mjs` fails the build when a registered MCP tool or HTTP
route does not exist.

| Capability | CLI | MCP | HTTP |
| --- | --- | --- | --- |
| `pools.list` | `blaster pools list` | `blaster_list_pools` | `GET /api/pools` |
| `pools.get` | `blaster pools show <id>` | `blaster_get_pool` | `GET /api/pools/:id` |
| `pools.create` | `blaster pools create --name <name>` | `blaster_create_pool` | `POST /api/pools` |
| `pools.addNumber` | `blaster pools add-number --pool <id> --number <e164>` | `blaster_add_pool_number` | `POST /api/pools/:id/numbers` |
| `pools.removeNumber` | `blaster pools remove-number --pool <id> --number <e164>` | `blaster_remove_pool_number` | `DELETE /api/pools/:id/numbers/:phoneNumber` |
| `pools.reorder` | `blaster pools reorder --pool <id> --order <e164,...>` | `blaster_reorder_pool` | `PUT /api/pools/:id/numbers` |
| `sequences.setPool` | `blaster pools assign --sequence <id> --pool <id>` | `blaster_set_sequence_pool` | `POST /api/sequences/:id/pool` |

The HTTP routes are operator-gated (they name provisioned numbers and rate
state), and the CLI and MCP reach them through the shared
`createBlasterApiClient`, so the three cannot disagree about a payload.

## How a number is removed from a pool

Removal is a **soft** removal. `convex/pool/mutations.ts`:

1. Resolve the phone number to a `phoneNumbers` row, then to its `poolNumbers`
   membership by the `poolPhoneNumber` index.
2. Patch the membership to `status: "removed"` with `removedAt`.
3. Compact the remaining live memberships so `order` stays contiguous.
4. Refresh the pool rollup in the same transaction.

It is not a delete because an in-flight send may already have chosen that number,
and because the record that the number was in the pool is worth keeping. Removing
the last active number is allowed; the runner parks the affected enrollment
`awaiting-human` rather than sending into an empty pool, which is visible and
recoverable instead of a silent stall.

To remove, from any surface:

```bash
blaster pools remove-number --pool <pool-id> --number +15551234567
```

## Scaling

Add a number to raise capacity:

```bash
blaster pools add-number --pool <pool-id> --number +15557654321
```

It is appended to `order`; dispatch naturally spreads across the larger pool.
The sequence is not touched. The order can be reset at any time with
`blaster pools reorder`.

## Wiring a pool to the sequencer

```bash
blaster pools assign --sequence <sequence-id> --pool <pool-id>
```

This writes `sequences.poolId`. A sequence with a pool takes its sending number
from `consumeSender` per send; a sequence without one keeps its fixed
`fromNumber`, so existing behaviour is unchanged. Omit `--pool` to clear the
assignment. The runner and its rate-limit behaviour are described in
[sequencer.md](sequencer.md).
