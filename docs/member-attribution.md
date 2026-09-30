# Member attribution

Every record Blaster creates in Twenty used to say the same thing: that the
anonymous Twenty API actor created it. That is accurate — Blaster authenticates
as the workspace with `TWENTY_API_KEY` — and it is useless, because "who did
this?" is the first question an operator asks about a row.

This is how a record gets a person's name on it.

## The one thing to know first

Twenty attributes a write to whoever authenticated it. There is no separate
"acting as" parameter. So the only way to attribute a write to a person is to
carry that person's identity in the request and hand it to Twenty as the actor.

Two consequences worth internalising:

- **`createdBy` can be set.** It is accepted on a create and reads back the
  member you passed.
- **`updatedBy` cannot.** Passing it is accepted and then recomputed by Twenty
  from the authenticated caller, so it silently does nothing. There is no API
  path to set it. Attribution reads `createdBy`; `ActorPayload` deliberately has
  no `updatedBy` field, because a type that promises something the API does not
  do is worse than an absent one.

And one that is the whole reason this needed a fix: **`sub` is not the
operator.** Twenty reports it as the *application* id, so resolving a member
from it matches no row and nothing is ever attributed. The identity is in the
access token's claims, not in the introspection subject. See
[docs/identity.md](identity.md).

The same word names two different things on the wire, which is the detail that
eats an afternoon: a Twenty **relation** is declared under its base name
(`agencyPhone`) and addressed in a REST write as `agencyPhoneId`. See
[twenty/agencyCall](call-history.md).

## The chain

```text
operator signs in
  -> Twenty issues an OAuth access token
  -> the API introspects it (that is the auth check)
  -> the access token's claims are read: userWorkspaceId, then userId
  -> either resolves to a workspaceMember
  -> the member id rides on the request
  -> resolveActor turns it into { createdBy: { source, workspaceMemberId, name } }
  -> the write carries that actor
```

Each step lives in one place:

| Step | Where |
| --- | --- |
| Introspect the token (the auth check) | `twenty/oauth` (`introspectToken`) |
| Read the token's claims | `twenty/oauth` (`decodeJwtPayload`) |
| Turn those claims into a `workspaceMember` | `twenty/workspaceMember` (`resolveMemberIdentity`) |
| Put it on the request | `apps/api/.../auth/operator` (`requireOperator`) |
| Attach it to a write | `twenty/client` (`create`, `update`) |

`workspaceMembers` is readable over the same REST surface as everything else, so
this needs no database access and no second credential.

Resolution is strongest-identifier-first: `userWorkspaceId` is a member id,
`userId` is what a member row carries in its `userId` column, and an email-shaped
claim is the last resort because it is the only one a human can retype. Email is
compared case-insensitively, since the two systems do not agree on case.

The token is decoded without verifying its signature. That is sound only because
introspection has already proved the token live and is the trust boundary — and
Twenty publishes no JWKS, so there is nothing to verify against regardless. It is
not a general licence to trust a JWT.

## Attribution is best-effort, and that is deliberate

`resolveActor` returns `null` when there is no member, and the write still
happens with Twenty's API actor. It also degrades rather than throwing when
Twenty cannot be reached, falling back to whatever name the request already had.

The reason is that not every write has a person behind it. A Convex action, a
scheduled sync, the CLI, and the Telnyx webhook all write with no operator
signed in. Blocking those would break working functionality to improve a
metadata field. Losing a display name is cosmetic; failing a write is not.

Two caches keep this cheap, because attribution sits on the hot path of a batch
send that touches Twenty once per recipient:

- `sub` to member id, in `resolveMemberIdentity` — keyed on `sub` because it
  survives token refresh, which an access token does not.
- member id to display name, in `resolveActor`.

Both are bounded with oldest-first eviction, and both export a `forget*` so a
test or an explicit refresh is possible.

## What is attributed

The `requireOperator` gate runs on the inbox routes, so the operator's own
actions are attributed. Two routes deliberately are not gated
(`/api/numbers/purchase`, `/api/phones/sync`); they pass an actor anyway, which
resolves to `null` when nobody is signed in, so the code is the same either way.

The Telnyx webhook is attributed to nobody, on purpose. It is machine to
machine; crediting a call to whichever operator signed in most recently would be
a worse lie than leaving it to the API actor.

## Two attribution channels

Records carry the native `createdBy` Actor *and* an own-field
`createdByMemberId` TEXT column. The redundancy is intentional: the Actor is
Twenty's own field and its read path could change, while the own-field is
queryable in a filter with no dependency on Twenty internals. The own-field is
omitted rather than faked when there is no member.

## Verifying it

`createdBy` is settable and `updatedBy` is not. Both were confirmed against the
live workspace, over REST `PATCH` and via the GraphQL `update<Singular>`
mutation: the mutation is accepted either way, and `updatedBy` reads back as the
API actor regardless of what was sent. Note that this Twenty version names the
mutation `update<Singular>` and not `updateOne<Singular>`, which does not exist
in the schema.

Tests: `packages/core/test/twenty-actor.test.ts`,
`packages/core/test/twenty-workspace-member.test.ts`.
