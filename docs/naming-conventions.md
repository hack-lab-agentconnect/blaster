# Naming conventions

A convention that is only half-enforced is worse than none, because it teaches
the reader to expect a structure that is not there. This document is the
backend rule, and `scripts/check-naming-conventions.mjs` is the gate that keeps
it true. If the two disagree, the gate is the bug.

This is the same convention the sibling `open-twenty-dialer` repo follows, and
matching it is deliberate: the same name means the same thing and does the same
job in both repos, so a reader who learns one does not have to re-learn the other.

**Scope: backend only.** Every rule here applies to backend source — the API,
the shared library, the CLI, and the MCP server. The frontend app is explicitly
out of scope: a React tree is organised by screen and component, which is a
different and perfectly good convention, and renaming it to satisfy a rule
written for server modules would make it worse. See "Scope" below for exactly
which directories are checked.

## The shape

```text
packages/{package}/src/{library}/{domain}/
├── index.ts        # required. The module's entry point: I/O, wiring, re-exports.
├── types.ts        # the domain's types, when it declares its own
├── client.ts       # optional. The I/O boundary: fetch, SDK, database.
├── machine.ts      # optional. A state machine.
└── helpers/        # optional. Pure functions only.
    ├── index.ts    # required whenever helpers/ exists.
    └── *.ts        # kebab-case, pure, no I/O.
```

`apps/api/src/` uses the same shape with a `lib/` level in front:

```text
apps/api/src/
├── index.ts        # process entry: binds the port, nothing else
└── lib/{library}/{domain}/...
```

Read it as **scope, then domain, then role**. `telnyx/messaging` is the messaging
domain of the telnyx integration. `twenty/agencyProspect` is the `agencyProspect`
domain of the twenty integration. A name tells you what it is and where it lives,
and the same name means the same thing in every project.

## Naming style: the external system wins

**A module that mirrors an external system uses that system's own naming style,
not this repo's.** This is the rule that matters most, because it is the one you
can silently get wrong.

Twenty's objects are **camelCase** — that is literally the value of
`nameSingular` in Twenty's own metadata (`agencyPhone`, `agencyProspect`,
`workspaceMember`, `person`, `message`). So a module mirroring a Twenty object is
named with that object's `nameSingular` **verbatim**:

| Module | Mirrors | Correct? |
| --- | --- | --- |
| `twenty/agencyPhone/` | object `agencyPhone` | yes |
| `twenty/agencyProspect/` | object `agencyProspect` | yes |
| `twenty/agencyCall/` | object `agencyCall` | yes |
| `twenty/workspaceMember/` | object `workspaceMember` | yes |
| `twenty/objectService/` | Twenty's object-metadata surface | yes |
| `twenty/actor/` | Twenty's `ACTOR` field type, on `createdBy` | yes |
| `twenty/agency-phone/` | — | **no**: invented kebab-case for a camelCase object |
| `twenty/phones/` | — | **no**: a generic noun, not an object name |

Not every domain in `twenty/` is a mirror. `twenty/client` and `twenty/graphql`
name a *transport*, and transports are repo-owned, so they are kebab-case like
any other repo-owned name. The test is the same one: ask what the name comes
from. `agencyCall` comes from Twenty and keeps Twenty's spelling; `client` is
ours and is spelled our way.

Two naming styles coexist deliberately:

1. **Mirrored modules** — anything whose name comes from an external system's
   vocabulary keeps that system's style. For Twenty: camelCase object names.
   Never re-spell them.
2. **Repo-owned modules** — modules the repo owns (helper verbs, cross-cutting
   utilities, `pipeline/`, `platform/`) use kebab-case.

To check a name: ask *what is the source of this name?* If the answer is a
Twenty object or concept, copy Twenty's spelling exactly.

`config/twenty-objects.json` is the allowlist the gate reads, so a camelCase
directory is legal only when it is one of the names in that file. That is what
lets the gate tell a deliberate mirror from a typo. The list is derived from the
generated schema, which is itself introspected from the live workspace, so it
carries no credential and needs no network at gate time. Regenerate it with
`pnpm twenty:objects` whenever the workspace's objects change, in the same commit
that renames a domain.

## Why the roles are separated

Each file role answers one question, so a reader never has to open a file to
find out what kind of thing it is:

| File | Holds | Never holds |
| --- | --- | --- |
| `index.ts` | The entry point: I/O, wiring, and re-exports | Pure business logic |
| `types.ts` | The domain's types, when it declares its own | Implementations |
| `client.ts` | Fetch calls, SDK calls, database access | Pure logic, business rules |
| `schema.ts` | Schema provisioning: creating the object and its fields | Record reads or writes |
| `helpers/*.ts` | Pure functions, unit-testable in isolation | I/O of any kind |
| `machine.ts` | States, events, transitions | Side effects outside the machine |

`types.ts` is the home for a domain's types, but it is not mandatory: a small
domain whose types live naturally next to the one helper that owns them is fine.

`schema.ts` exists because schema mutation and record I/O have different failure
costs and different callers. Provisioning runs once, deliberately, by whoever
sets a workspace up, and it changes the *shape* of the object. Record I/O runs on
every inbound webhook. Keeping them apart is what stops a webhook from being able
to alter the object it is writing to. See `twenty/agencyCall/`.

The split that matters most is **pure helpers vs. `client.ts`**. A helper can be
tested with no network and no credentials, which is why the business rules live
there and why the tests are fast. The moment a helper needs to fetch something,
it has crossed a boundary and belongs in a client or in `index.ts`.

## The barrel is a barrel

A module's `index.ts` is the entry point: it holds the I/O and the wiring, and
re-exports the module's surface. It is what everything outside the module
imports, and nothing outside a module reaches past it into `helpers/`.

```ts
// index.ts - the entry point, matching the sibling dialer repo
export * from "./helpers/index.ts";
export type { Breakdown, Count } from "./types.ts";
```

`helpers/index.ts` re-exports each helper the same way. This matches the
sibling repo exactly, which is the point: the same name and the same shape in
both repos means a reader who learns one does not have to re-learn the other.

## Naming rules

| Thing | Rule | Example |
| --- | --- | --- |
| Library directory | lowercase kebab-case | `telnyx`, `twenty`, `blaster` |
| Domain directory, repo-owned | lowercase kebab-case | `messaging`, `breakdown` |
| Domain directory, Twenty mirror | Twenty's `nameSingular`, verbatim | `agencyPhone`, `objectService` |
| Helper file | lowercase kebab-case, always | `phone-format.ts`, `build.ts` |

A helper file is kebab-case even inside a camelCase mirror: the directory
follows the external system, the files inside it are still ours.

Prefer singular for repo-owned domains. `telnyx/messaging` is one domain;
`telnyx/messages` reads like a collection of message files, which is what
`helpers/` is for. A mirrored domain is exempt from this, because its plurality
is Twenty's decision, not ours.

## Rules the gate enforces

1. Backend library and domain directories are lowercase kebab-case, **or** exactly
   a Twenty name from `config/twenty-objects.json`.
2. Backend `.ts` file names are lowercase kebab-case, with no exception: a
   camelCase *file* is always wrong, even inside a camelCase mirror.
3. Every domain has an `index.ts`.
4. Every `helpers/` directory has an `index.ts` barrel.
5. No helper imports its parent domain's `index.ts`.

Each violation is reported as `path: reason` and fails the pre-push hook. The
object allowlist itself is checked too: `pnpm twenty:objects:check` fails when
`config/twenty-objects.json` no longer matches the generated schema, so an object
rename cannot leave a stale allowlist behind.

## Exemptions

| Path | Why |
| --- | --- |
| `**/generated/**` | Machine output, emitted by `pnpm twenty:client`. Its file names and exports are the generator's, not ours; editing them is pointless because the next run overwrites them. |
| Frontend trees | Out of scope entirely; see "Scope". |
| `convex/` | Not ours. The Convex framework fixes its own file names (`convex.config.ts` is required by name) and its function-module naming. It is out of scope rather than exempted, so the rule cannot creep into it. |

Adding a path to the exemption list is a deliberate act with a reason in the
gate, not a way to silence a failure.

## Scope

Checked:

```text
packages/*/src
apps/api/src
lib
```

Not checked:

```text
apps/web/src      # frontend: screens and components, organised by feature
convex/           # the Convex framework's own tree, its file names are its own
apps/*/test
*.test.ts         # tests sit beside what they test
```

Adding a backend package to the gate is automatic: any directory matching
`packages/*/src` is checked. Adding a new app means adding its path to
`BACKEND_ROOTS` in the gate.

## Working with it

When adding a module, create the whole shape rather than a bare directory:

```text
telnyx/webhook/
├── index.ts      # export * from "./helpers/index.ts" + the I/O
├── types.ts      # export interface TelnyxWebhookEvent { ... }
└── helpers/
    ├── index.ts
    └── verify.ts
```

A mirror follows the same shape with Twenty's spelling on the directory:

```text
twenty/agencyCall/
├── index.ts
├── types.ts
└── helpers/
    ├── index.ts
    └── map-call.ts
```

The question "where do I put this?" should have one answer, and it should be
written down here rather than rediscovered per project. The rule that decides
*which* name you use is the first question to ask: what is the source of this
name? If the answer is a Twenty object, copy Twenty's spelling and add the name
to `config/twenty-objects.json` if it is not there yet.
