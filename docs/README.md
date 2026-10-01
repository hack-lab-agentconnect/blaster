# Documentation

Two kinds of documentation live here, and the difference matters.

**Authored** documentation is ours, is committed, and is held to the brand and
naming gates:

| File | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | How the Hono and Convex runtimes split, the Twenty sharp edges, and the messaging profile rules |
| [identity.md](identity.md) | Signing in with Twenty, the auth-guard wall, and which credential opens which path |
| [deployment.md](deployment.md) | How pushes become production: the build, the tracked function shim, failure modes, and rollback |
| [send.md](send.md) | The prospect batch send: the intent, the four routes, the filter menu, and the per-recipient response shape |
| [naming-conventions.md](naming-conventions.md) | The required `{library}/{domainname}/helpers` directory structure |

**Vendored** documentation is third-party reference material, pulled in for the
libraries this repository actually depends on. It is gitignored, so it is never
committed and never brand-checked, but it is on disk and freely editable for
local reference.

## Vendored suites

Each suite is a full mirror of that project's own documentation, and each is here
because the corresponding library is a real dependency.

| Suite | Library | Why Blaster depends on it | Where it is used |
| --- | --- | --- | --- |
| `docs/convex/` | `convex` 1.46 | Database, functions, scheduling, and the component host | `convex/schema.ts`, `convex/http.ts`, `convex/blaster.ts` |
| `docs/telnyx/` | `@listeningkit/telnyx` + the Telnyx API | SMS sending, messaging profiles, inbound webhooks | `packages/core/src/telnyx/messaging/`, `convex/convex.config.ts` |
| `docs/treg/` | `@listeningkit/treg` | Prospect discovery and enrichment, with a cost ceiling | `convex/convex.config.ts`, `convex/discoveryRuns` schema |
| `docs/agentmail/` | `@agentmail/convex` | Inbound email events | `convex/convex.config.ts` |
| `docs/hono/` | `hono` 4.6 | The HTTP request surface | `apps/api/src/index.ts` |

`docs/convex/components/` is the exception to the ignore rule and is kept in
version control, because those pages are written for this project rather than
mirrored.

## Dependencies with no vendored suite

Two libraries Blaster depends on are documented upstream only. Their behaviour
that matters here is recorded in our own pages rather than mirrored.

| Library | Used for | Read this instead |
| --- | --- | --- |
| `libphonenumber-js` | Resolving a recipient number to an ISO country | [architecture.md](architecture.md), the messaging profile section |
| `@modelcontextprotocol/server` 2.x | The MCP server surface | [README.md](../README.md), the surfaces section |

## Working with the vendored copies

They are ignored by git, so editing one is safe and local: a change never
reaches a commit, and a `git clean` would remove it. To refresh a suite from
another checkout, copy the directory over the top:

```bash
robocopy <source>\docs\telnyx docs\telnyx /E
```

If a fact in a vendored suite is wrong for this project, do not edit the mirror.
Write the correction in `docs/architecture.md`, where it is committed, and use
the mirror only to check what the library actually does.
