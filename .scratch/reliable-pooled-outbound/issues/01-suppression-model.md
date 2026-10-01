# Suppression model

Type: grilling
Status: resolved
Blocked by:

## Question

An opt-out is recorded on one enrollment and is sticky for that enrollment, but
there is no durable, per-person suppression: a later enrollment in another
sequence, sending from another pool number, re-snapshots `doNotContact` from the
Twenty prospect and can text someone who already replied STOP. Pools multiply the
numbers a prospect can be reached from, so this gets worse, not better.

Decide the suppression model: is a STOP a fact about the *person* (a
`suppressions` row keyed on the E.164 peer) or about the *(person, number)* pair?
What resumes it, who may resume it, and does a plain reply (not STOP) also
suppress across sequences or only stop the one enrollment? The answer fixes the
schema, the enroll-time check, and the send-time check.

## Answer

Decisions, each tied to a fact already in the codebase.

**1. Scope of a suppression: the person, not the number.** A suppression is a
fact about the person (the E.164 peer). Texting someone who said STOP from a
second pool number is the same harm as from the first — the rotor is ours, not
theirs — so the key is the peer alone. It is deliberately *not* keyed on
`(peer, number)`: that would let rotation walk around a person's STOP, which is
exactly the harm pools introduce. This matches the inbound path, which is already
number-agnostic: `stopEnrollmentsForPeer` stops every enrollment for the peer
regardless of which number received the reply, and the reply re-check
(`peerHasReplied`) now scans every thread for the peer.

**2. Which inbound event suppresses.** Only a deterministic `opt_out` (a STOP /
unsubscribe, confidence 1) creates a durable suppression. A plain reply still
stops the one enrollment (`replied`) and nothing more, because a reply is not a
request to never be contacted. The classifier already gives this exactly:
`classifyMessageRules(...).state === "opt_out"` is confidence 1 and is what the
webhook passes as `optedOut` (apps/api/src/index.ts). Suppression is therefore
driven by the same event that already flips an enrollment to `opted-out`.

**3. Additive, never overriding.** `suppressions` is a second, durable layer over
the existing enrollment status, not a replacement. `enrollment.status ===
"opted-out"` still means "this enrollment is stopped"; a `suppressions` row means
"this person is suppressed everywhere, until a human lifts it". Reading them
together is what closes the gap, because the enrollment status cannot see a
sibling sequence and the snapshot cannot see a later STOP.

**4. Checked at two points, one helper each.** Written inbound by the same
transaction that stores the message and stops enrollments, so a stored STOP and
its suppression cannot disagree. Checked at **enroll** (refuse to create an
active enrollment for a suppressed peer) and at **send** (a new
`isSuppressed(ctx, peer)` inside `loadRunContext`, so a suppression that lands
mid-sequence stops the next step even before `stopEnrollmentsForPeer` catches the
status). The `isSuppressed` read is the one implementation, shared by both.

**5. Resumption is a deliberate human act.** A suppression is lifted only by an
explicit resolve mutation that records who and why (a new inbound START/UNSTOP is
**not** accepted; that is a fresh decision, not this ticket's to grant), and
lifting it does not resurrect an enrollment — the peer must be enrolled again,
with a fresh do-not-contact snapshot. This keeps "unsubscribe is sticky" true
across sequences, which is the property the current per-enrollment model lacks.

**Consequences for the tickets that follow:**
- The schema is `suppressions { peer, reason, source ("inbound-opt-out" |
  "manual"), createdAt, liftedAt? liftedBy? }`, keyed on `peer`, plus a
  `isSuppressed(ctx, peer)` helper both the enroll and send paths call.
- The enroll path gains: read the snapshot *and* `isSuppressed`, refuse if either
  says stop.
- The send path gains: `loadRunContext` sets `hasReplied`-style suppression as
  another eligibility input, or reuses the existing `doNotContact` input by
  folding the suppression into it — the latter keeps the core eligibility rules
  unchanged and is the smaller change.
- Ticket 04 (the convex-test harness) is now unblocked only on ticket 02 too;
  this decision does not depend on thread identity, but the harness's first tests
  should cover this suppression path.
