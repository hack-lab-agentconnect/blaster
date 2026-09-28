<p align="center">
  <img src="banner.png" alt="Blaster" width="100%">
</p>

# Blaster

Blaster reads a Twenty CRM workspace, reports what the pipeline actually looks
like, and sends SMS through the Telnyx messaging profile registered for the
recipient's country. It is internally deployed software on `railcode.dev`, and
it is reachable three ways: a CLI, an MCP server, and an HTTP API.

## What it does

- **Reads Twenty.** Leads, calls, and prospects come from the Twenty workspace
  over its REST API, with keyset pagination and tolerant response unwrapping.
- **Reports the pipeline.** A breakdown of lead status, call outcomes, answer
  rate, and conversion, plus the notifications those numbers currently trigger.
- **Sends SMS on the right profile.** Country detection goes through a phone
  number library, and the messaging profile is chosen from the recipient's
  jurisdiction before the send.
- **Finds prospects with treg.** Discovery runs through the treg Convex
  component, with a per-call cost ceiling and a spend ledger.

## Why the messaging profile matters

A Telnyx messaging profile is a registration, not a preference. US recipients
need a 10DLC brand and campaign. Ireland and the UK cannot use 10DLC at all and
need a profile carrying an alphanumeric sender.

Sending an Irish number from a US profile is accepted by Telnyx and then rejected
by the carrier. So Blaster resolves the profile from the recipient *before* the
send, and when a country has no registered profile it falls back to the default
and returns a warning naming the variable to set. Adding a country is a
configuration change, never a code change:

```bash
TELNYX_MESSAGING_PROFILES=US=<id>,IE=<id>,GB=<id>,DE=<id>
```

## The three surfaces

| Surface | Command | What it is |
| --- | --- | --- |
| CLI | `blaster` | The `blaster` binary, for scripting and one-off work |
| MCP | `blaster-mcp` | Stdio MCP server on `@modelcontextprotocol/server` 2.x |
| HTTP | `apps/api` | A Hono worker, the request surface for the Railcode app |

All three read the same domain code, so an answer cannot differ between them.

```bash
blaster breakdown                       # counts, rates, firing notifications
blaster env                             # every variable and whether it is set
blaster profile --to +353871234567     # which profile a recipient resolves to
blaster prospects agencyLeads --json    # records straight from Twenty
blaster capabilities                    # every capability and its surfaces
blaster send --to <to> --from <from> --text <text>
```

```json
{
  "mcpServers": {
    "blaster": {
      "command": "blaster-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

MCP tools: `blaster_breakdown`, `blaster_env`, `blaster_messaging_profile`,
`blaster_send_message`, `blaster_list_records`.

## What is inside

```
apps/api             Hono HTTP surface (the Railcode worker)
convex/              Convex backend: schema, treg + telnyx components, functions
packages/core        The domain. Every business rule lives here
  src/twenty/crm           Twenty REST client, unwrapping, keyset paging
  src/telnyx/messaging     Profile resolution and the Telnyx client
  src/pipeline/breakdown   The breakdown builder and notification rules
  src/platform/env         The environment manifest reader
packages/blaster-cli  The blaster binary
packages/blaster-mcp  The blaster-mcp server
config/env-vars.json  The environment contract every surface reads
docs/                Architecture and the naming convention
scripts/             The pre-push gates
```

Each part, and why it exists:

- **`apps/api`** owns the request surface and nothing else. It resolves the
  dependency a route needs and delegates; anything that writes provider state is
  a Convex function, so there is exactly one owner of a write.
- **`convex/`** holds the database, the mounted `treg` and `telnyx` components,
  and the read-only HTTP routes a deployment can be inspected through.
- **`packages/core`** is the only place a business rule lives. The breakdown
  builder and the notification rules are pure functions, so they are tested with
  no workspace and no credentials.
- **`packages/blaster-cli`** and **`packages/blaster-mcp`** are thin shells over
  core. Neither holds logic, which is why they cannot disagree.
- **`config/env-vars.json`** is the contract. The API, the Convex backend, and
  the docs all read it, and a gate fails the build when a variable is declared
  but unread, read but undeclared, or marked planned without a reason.

## Setup

```bash
pnpm install
cp .env.example .env.local
```

Fill in `TWENTY_BASE_URL`, `TWENTY_API_KEY`, `TELNYX_API_KEY`, and
`TELNYX_MESSAGING_PROFILE_ID`. Add the country profiles you have registered.
`blaster env` tells you exactly what is still missing, and which countries have
no profile.

```bash
pnpm dev                # the Hono API on :4180
pnpm convex:dev         # a local Convex deployment
pnpm test               # the pure logic, no credentials needed
pnpm run check          # every gate
```

## Deployment

Blaster deploys to `railcode.dev` as a private app. `railcode.json` points at
the Hono worker and `manifest.yaml` scopes the `twenty` connector, so the worker
reads Twenty through the platform rather than carrying a long-lived API key.
The Railcode CLI builds the worker; there is no bundler config in the repo.

Convex functions deploy separately with `pnpm convex:deploy`.

## Gates

`lefthook.yml` runs these before every push, cheapest first:

| Gate | Enforces |
| --- | --- |
| `check:naming` | the `{library}/{domainname}/helpers` convention |
| `check:env` | the manifest and the code agree, in both directions |
| `check:no-emoji` | no emoji anywhere in the repository |
| `check:no-font-mono` | forbids any fixed-width font from rendering |
| `typecheck` | all four packages, strict |
| `test` | the pure logic |

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the two runtimes split, the
  Twenty sharp edges, and the profile rules
- [docs/naming-conventions.md](docs/naming-conventions.md) — the required
  directory structure
