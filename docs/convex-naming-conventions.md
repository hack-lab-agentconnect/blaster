# Convex naming and directory conventions

A project-agnostic convention for organising a Convex backend. It has three
parts that must not be confused:

- **Framework requirements** (F-rules): imposed by Convex. Violate them and the
  deploy breaks. The gate does not need to enforce most of these — the
  framework already does, loudly, at `convex dev` time.
- **Repository rules** (R-rules): imposed by us, enforced by the `check:convex`
  gate. Violate them and the pre-push hook fails.
- **Recommendations** (G-rules, for *guidance*): documented judgment calls the
  gate deliberately does not check, because they need a human to evaluate them.

Each rule is labelled with which part it belongs to and why it exists. A rule
that guesses at intent would be brittle, so anything the gate cannot check
objectively lives in G, never in R.

## Framework requirements (Convex imposes these)

These come from the Convex documentation and the CLI bundled with the
`convex` package. They are not negotiable and the lint gate does not need to
enforce them — the framework already does, loudly, at `convex dev` time.

### F1. The backend lives in `convex/`
`convex dev` pushes the contents of the `convex/` directory to the deployment
and derives types from it. ([Workflow](https://docs.convex.dev/understanding/workflow))

### F2. *When* a schema is defined, it lives at `convex/schema.ts` with a default export
Convex applications may run without an explicitly defined schema. When a
schema is defined, it is declared in a `schema.ts` file in the `convex/`
directory with `export default defineSchema({...})`, and codegen imports that
module to produce `dataModel.d.ts`. ([Schemas](https://docs.convex.dev/database/schemas),
[schema.ts config](https://docs.convex.dev/config/schema.ts))

Because this repository uses schema validation, the gate treats a root
`schema.ts` with a default export as a **repository requirement** (see R10),
not as a universal framework mandate. A schemaless Convex project would not
need it.

### F3. File path plus export name is the function address
Queries, mutations, and actions are defined in TypeScript files inside
`convex/`. The path and name of the file, plus the way the function is
exported, determine the name clients use: `convex/foo/myQueries.ts` exporting
`listMessages` is called as `api.foo.myQueries.listMessages`. A default export
is addressed as `default`. ([Query functions](https://docs.convex.dev/functions/query-functions))

Consequences that matter for everything below:
- Moving a function file **renames its public address**. A restructure is an
  API migration and every `api.*` / `internal.*` call site must move with it.
- Two modules exporting the same function name create **two addresses**. A
  barrel that re-exports a Convex function does not alias it — it duplicates
  it. Never re-export a function through an index file.

### F4. Nested directories namespace the API
Subdirectories under `convex/` are supported and become API namespaces, as in
`api.foo.myQueries.listMessages`. ([Query functions](https://docs.convex.dev/functions/query-functions))

### F5. `convex/http.ts` owns HTTP routes via a default-exported router
HTTP endpoints are defined with `httpRouter` + `httpAction` and the file
default-exports the router. Route `path` is the exact URL path. ([HTTP actions](https://docs.convex.dev/functions/http-actions))

### F6. `convex/crons.ts` owns scheduled jobs
Cron jobs are defined in a `crons.ts` file with `cronJobs()`. Cron targets must
be function references. ([Cron jobs](https://docs.convex.dev/scheduling/cron-jobs))

### F7. `convex/_generated/` is machine output
Codegen writes it on every `convex dev` run. Check it in so the tree typechecks
without a running daemon, and never edit it by hand. ([Best practices](https://docs.convex.dev/understanding/best-practices/))

### F8. `convex/convex.config.ts` is a fixed name
Required by the framework for component mounting (`app.use(...)`).

## Repository conventions (we impose these on ourselves)

Convex enforces nothing about case style — its own examples mix cases in one
tree — so the style rules below are ours. They exist so a reader can tell what
kind of thing a name is without opening the file.

### R1. camelCase for everything multi-word inside `convex/`
Files, directories, tables, fields, indexes, and function names use camelCase:
`phoneNumbers.ts`, `sequenceEnrollments`, `nextDueAt`, `recordInboundMessage`.
Single-word names stay lowercase: `schema.ts`, `http.ts`, `queries.ts`.

Why camelCase rather than the kebab-case used elsewhere in this repo: the
function address *is* the file path (F3), so the file name is a public API
surface, and the framework's own examples and generated paths use camelCase.
Fighting that inside `convex/` would mean fighting the tool. The boundary is
the directory: kebab-case outside, camelCase inside.

### R2. Tables are camelCase plural nouns; fields are camelCase
`sequenceEnrollments`, not `sequence_enrollments` or `SequenceEnrollment`.
Field names are plain camelCase keys; Convex derives TypeScript types directly
from them, so the casing flows end to end.

### R3. Index names mirror the indexed field path
An index on `["providerEventId"]` is named `"providerEventId"`. Compound
indexes join with nothing added. The name tells you exactly what the index
serves without opening the schema.

### A note on what follows (R4–R7)
Convex does not require any particular directory layout. Its own best-practices
page recommends thin public function wrappers over shared helper logic, but not
this exact structure — the layout below is this repository's architecture, not
a framework mandate. ([Best practices](https://docs.convex.dev/understanding/best-practices/))

### R4. One domain per directory; one function kind per file
```
convex/
├── schema.ts            # index only: spreads schema/<domain>.ts (R6)
├── http.ts              # index only: registers http/<domain>.ts (R7)
├── crons.ts             # cron registrations only, targets internal.* (F6)
├── schema/
│   └── <domain>.ts      # table definitions for one domain, no functions
├── http/
│   └── <domain>.ts      # route registrations for one domain, no handlers inline
└── <domain>/
    ├── schema.ts        # (optional) table definitions, re-exported via schema/<domain>.ts
    ├── model.ts         # context-bound logic: takes ctx, calls core helpers, writes nothing else
    ├── queries.ts       # thin wrappers over model.ts
    ├── mutations.ts     # thin wrappers over model.ts
    ├── actions.ts       # external side effects only (network, AI); no db writes
    └── workflow.ts      # durable execution; deterministic body, I/O only inside steps
```

Only create the files a domain needs. A domain with no external calls has no
`actions.ts`; a domain with no long-lived process has no `workflow.ts`.

### R5. Thin wrappers over a `model.ts` layer
Public functions (`queries.ts`, `mutations.ts`) validate args, call one model
function, and return. All branching and all database access beyond that call
lives in `model.ts`. This is the framework's own recommended shape — "most of
your code should live in a model directory, with very short public functions
that mostly just call into it" ([Best practices](https://docs.convex.dev/understanding/best-practices/)) —
kept compatible with this repo by one additional constraint: pure decisions
(eligibility, arithmetic, time math) belong in the shared core library where
they are unit-testable without a database; `model.ts` takes `ctx`, asks core
to decide, and persists the answer.

Why the split matters: a query or mutation handler is hard to unit test
(it needs a database), while a pure function is trivial to test. Every line
moved from a handler into a pure helper is a line the test suite can reach.

### R6. Root `schema.ts` composes; it defines nothing
```ts
import { defineSchema } from "convex/server";
import { userTables } from "./schema/users.js";

export default defineSchema({ ...userTables });
```
Table definitions live in `schema/<domain>.ts` (or `<domain>/schema.ts`
re-exported through it). The root file owns no tables directly, so growing
the schema never means editing a file everything imports. This is plain
TypeScript composition around the framework's root-schema contract (F2).

### R7. Root `http.ts` registers; it handles nothing
```ts
import { httpRouter } from "convex/server";
import { registerUserRoutes } from "./http/users.js";

const http = httpRouter();
registerUserRoutes(http);
export default http;
```
Each `http/<domain>.ts` exports a `register*Routes(http)` function. Handlers
stay small and delegate to mutations/actions; a route handler must not contain
business logic.

### R8. Internal calls use `internal.*`, never `api.*`
Any `runQuery`, `runMutation`, `runAction`, or scheduler target inside
`convex/` — including cron targets (F6) — must reference `internal.*`
functions. To be precise about why: calling a public function does not bypass
that function's own access controls, so this is not a framework restriction.
It is a security-oriented project convention — backend-only calls, and
scheduled calls in particular, should target functions that are not
client-reachable, so a future change to a public function's exposure cannot
silently widen what the backend itself can invoke. The framework's own
best-practices page recommends the same split. ([Best practices](https://docs.convex.dev/understanding/best-practices/))

### R9. No function re-exports through barrels
Because of F3, `export * from "./queries.js"` inside a domain `index.ts`
would publish every function under a second address. Function modules are
imported directly by path. Barrels may re-export *types and constants only*,
with explicit `export type`, never values that could be function references.

### R10. This repository defines a schema, so root `schema.ts` is required
Per F2, a schema itself is optional in Convex. This repository uses schema
validation, so a root `schema.ts` with a default export is required here.
A project without schema validation would not need this rule.

## Recommendations (guidance, not gated)

These are documented judgment calls. The gate does not check them because no
script can evaluate them without understanding intent.

### G1. Only create the files a domain needs
A domain with no external calls has no `actions.ts`; a domain with no
long-lived process has no `workflow.ts`. An empty file created "for symmetry"
is clutter, not structure.

### G2. Prefer fewer, larger domains over many tiny ones
A two-table file does not earn its own directory. Split when a file becomes
hard to navigate (roughly: longer than a screenful of tables, or owned by a
different concern than its neighbours), not before.

### G3. Keep the public surface minimal
Every `query`/`mutation`/`action` is a public API address unless marked
`internal`. Before adding one, check whether an existing function already
answers the question. The cheapest function to maintain is the one that was
never written.

## What the gate enforces

The `check:convex` gate enforces exactly the R-rules that are objectively
checkable without understanding intent:

- every filename under `convex/` (outside `_generated/`, any extension) is
  camelCase or a single lowercase word; only `convex.config.ts` is matched by
  exact name, and only at the root (`schema.ts`, `http.ts`, and `crons.ts` pass
  the casing rule on their own and need no exemption);
- every directory name under `convex/` (outside `_generated/`) follows the same
  rule;
- root `schema.ts` exists with a default export (R10 — required here because
  this repository uses schema validation);
- a root `http.ts`, when present, default-exports the router; a root
  `crons.ts`, when present, builds its schedule with `cronJobs()`;
- no `export *` in any `convex/` file (R9 — the duplicate-address hazard);
- no `api.*` function references inside `convex/` (R8).

Content checks run against code with comments and string literals stripped, so
a commented-out line or a mention in a string neither flags nor hides a real
violation. The G-rules are never checked: no script can tell whether a domain
deserves its own directory, whether a `model.ts` delegates enough, or whether
a table name is a good noun. Those stay documented here instead.

## Provenance

Every F-rule links to the Convex documentation it comes from. If the framework
changes, the F-rules change with it and the R-rules are re-examined — a
convention that contradicts its framework is a bug in the convention, not in
the framework.
