# Naming conventions

A convention that is only half-enforced is worse than none, because it teaches
the reader to expect a structure that is not there. This document is the
backend rule, and `scripts/check-naming-conventions.mjs` is the gate that keeps
it true. If the two disagree, the gate is the bug.

**Scope: backend only.** Every rule here applies to backend source — the API,
the shared library, the CLI, and the MCP server. The frontend app is explicitly
out of scope: a React tree is organised by screen and component, which is a
different and perfectly good convention, and renaming it to satisfy a rule
written for server modules would make it worse. See "Scope" below for exactly
which directories are checked.

## The shape

```text
packages/{package}/src/{library}/{domain}/
├── index.ts        # required. The domain's public surface, named exports.
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
domain of the telnyx integration. `twenty/prospects` is the prospects domain of
the twenty integration. A name tells you what it is and where it lives, and the
same name means the same thing in every project.

## Why the roles are separated

Each file role answers one question, so a reader never has to open a file to
find out what kind of thing it is:

| File | Holds | Never holds |
| --- | --- | --- |
| `index.ts` | The public surface, as named exports | Logic, I/O, anything a caller should not reach |
| `types.ts` | The domain's types, when it declares its own | Implementations |
| `client.ts` | Fetch calls, SDK calls, database access | Pure logic, business rules |
| `helpers/*.ts` | Pure functions, unit-testable in isolation | I/O of any kind |
| `machine.ts` | States, events, transitions | Side effects outside the machine |

`types.ts` is the home for a domain's types, but it is not mandatory: a small
domain whose types live naturally next to the one helper that owns them is fine.
What matters is that the *barrel* names every type it exposes, so the type
surface is as readable as the function surface.

The split that matters most is **pure helpers vs. `client.ts`**. A helper can be
tested with no network and no credentials, which is why the business rules live
there and why the tests are fast. The moment a helper needs to fetch something,
it has crossed a boundary and belongs in a client.

## Named exports, not wildcards

```ts
// index.ts - the surface is readable without opening another file
export { buildBreakdown, summarise } from "./helpers/build.ts";
export type { Breakdown, Count } from "./types.ts";
```

```ts
// not this: the surface is now unknowable without reading every helper
export * from "./helpers/build.ts";
```

`export *` is how a domain's public API becomes invisible. With named exports
the whole surface of a domain is one screen, which is the difference between
finding the function you need and grepping for it. This is enforced: a domain
`index.ts` containing `export *` fails the gate.

`helpers/index.ts` may still use `export *`, because the domain root above it
is the readable surface and the helpers beneath are an implementation detail.

## Naming rules

| Thing | Rule | Example |
| --- | --- | --- |
| Library directory | lowercase kebab-case | `telnyx`, `twenty`, `blaster` |
| Domain directory | lowercase kebab-case | `messaging`, `phone-derived-state` |
| Helper file | lowercase kebab-case | `phone-format.ts`, `build.ts` |
| Library and domain names | single word where possible | `messaging`, not `message-handling` |

Prefer singular domain names. `telnyx/messaging` is one domain; `telnyx/messages`
reads like a collection of message files, which is what `helpers/` is for.

## Rules the gate enforces

1. Backend library and domain directories are lowercase kebab-case.
2. Backend `.ts` file names are lowercase kebab-case.
3. Every domain has an `index.ts`.
4. Every `helpers/` directory has an `index.ts` barrel.
5. No helper imports its parent domain's `index.ts`.
6. A domain `index.ts` uses named exports, not `export *`.

Each violation is reported as `path: reason` and fails the pre-push hook.

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

When adding a domain, create the whole shape rather than a bare directory:

```text
telnyx/webhook/
├── index.ts      # export { verifyTelnyxWebhook } from "./helpers/verify.ts"
├── types.ts      # export interface TelnyxWebhookEvent { ... }
└── helpers/
    ├── index.ts
    └── verify.ts
```

A flat domain with no `types.ts` fails the gate, and that is the point: the
question "where do I put this?" should have one answer, and it should be written
down here rather than rediscovered per project.
