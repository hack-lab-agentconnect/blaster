# Thread identity under rotation

Type: grilling
Status: resolved
Blocked by:

## Question

A conversation is keyed on `(peer, blasterNumber)`, so a contact reached from
three pool numbers has three threads. `campaignFor` reunites them under one
campaign, but the inbox still shows one row per number, and the reply re-check now
scans every thread for the peer.

Decide what the canonical thread is: (a) keep the per-number threads and give the
inbox a grouped "one person" view, (b) key the thread on the peer with the
sending number as an attribute that changes over time, or (c) something else.
The answer decides whether a reply, an unread badge, and a STOP are counted once
or N times, and what `campaignFor` should match on.

## Note (partial clarity from ticket 01)

Ticket 01's decision fixes one half of this: a STOP is per-person, so an
unread-badge or a suppression is counted once regardless of how many threads the
peer has. The remaining question is presentation — whether the per-number threads
become one grouped "person" row in the inbox, or the thread is re-keyed on the
peer with the number as a mutable attribute. `campaignFor` already reunites them
by campaign, so the decision is about the inbox's default row, not correctness.

## Answer

Decision: **keep the per-number threads as the storage model; the inbox gains a
person-level grouping, and the thread row stays the canonical per-number record.**

Three reasons, each grounded in what is already there:

1. **`(peer, blasterNumber)` is the right key.** A conversation is a
   `pairKey`; inbound and outbound resolve to the same row because both ends are
   known. Re-keying the thread on the peer alone would need a rule for which
   number a message "belongs to" when a pool sends from a different one each
   time, and would lose the fact that the operator did, in fact, text from two
   numbers. The number is a real attribute of the relationship, so it stays in
   the key.

2. **The grouping is presentation, and `campaignFor` already does the join.**
   `listConversations` resolves each thread's campaign; the same pass can group
   threads by peer when `withCampaign` is on, without a second query. So the
   inbox can show one row per person with the numbers they were reached from as
   sub-rows, and no storage changes.

3. **The person-level facts are already person-level.** Ticket 01 made the STOP
   per-person, and `stopEnrollmentsForPeer`/`peerHasReplied` are peer-wide, so a
   reply, an opt-out, and a suppression are each counted once regardless of how
   many threads exist. The only thing left per-number is the message history,
   which is where it belongs.

Consequences:
- The inbox list query gains a `groupBy: "person" | "thread"` argument; `person`
  folds its rows by `phoneNumber` and surfaces the `blasterNumber`s as a set.
  Default stays `thread` so nothing that reads today's shape changes.
- `campaignFor` is unchanged; a person row's campaign is the union of its
  threads' campaigns, and reports `multiple` when they differ (which is the
  existing ambiguity rule, applied one level up).
- No schema migration. This is a read-shape decision, and the write path
  (`resolveConversation`) is untouched.

Ruled out: re-keying conversations on the peer (loses the sending number), and a
denormalized `person` table (a cache with no owner, since the truth is derivable
from the threads in one query).
