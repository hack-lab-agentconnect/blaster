<p align="center">
  <img src="banner.png" alt="Blaster" width="100%">
</p>

# Blaster

Blaster reads a Twenty CRM workspace, reports what the pipeline actually looks
like, and sends SMS through the Telnyx messaging profile registered for the
recipient's country. It is internally deployed software on `railcode.dev`, and
it is reachable three ways: a CLI, an MCP server, and an HTTP API.

```mermaid
flowchart TB
  subgraph clients["Clients"]
    CLI["blaster CLI"]
    MCP["blaster-mcp<br/>MCP over stdio"]
    WEB["HTTP callers"]
  end
  subgraph api["Request surface"]
    HONO["Hono worker - apps/api<br/>Railcode app on railcode.dev"]
  end
  subgraph core["Domain library - packages/core"]
    CLIENT["twenty/client"]
    MSG["telnyx/messaging"]
    BRK["pipeline/breakdown"]
    ENV["platform/env"]
  end
  subgraph convex["Convex backend"]
    FN["blaster.ts<br/>queries and mutations"]
    TREG["treg component"]
    TEL["telnyx component"]
  end
  TWENTY[("Twenty CRM")]
  TELNYX["Telnyx API"]
  MANIFEST[("config/env-vars.json")]

  CLI --> core
  MCP --> core
  WEB --> HONO
  HONO --> core
  HONO -. "writes" .-> FN
  CLIENT --> TWENTY
  MSG --> TELNYX
  BRK --> CLIENT
  MANIFEST -. "read by" .-> core
  MANIFEST -. "read by" .-> convex
  TREG --> FN
  TEL --> FN

  classDef store fill:#1b1030,stroke:#7c5cff,color:#f5f7ff
  classDef ext fill:#0b1020,stroke:#5ee7ff,color:#f5f7ff
  class TWENTY,TELNYX ext
  class MANIFEST store
```

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
  src/twenty/client        Twenty REST client, unwrapping, keyset paging
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

`lefthook.yml` runs these before every push, in this order:

| Gate | Enforces |
| --- | --- |
| `check:secrets:self-test` | the scanner still separates known-bad from known-good fixtures |
| `check:secrets` | no credential is committed |
| `check:naming` | the `{library}/{domainname}/helpers` convention |
| `check:env` | the manifest and the code agree, in both directions |
| `check:no-emoji` | no emoji anywhere in the repository |
| `check:no-font-mono` | forbids any fixed-width font from rendering |
| `typecheck` | all four packages, strict |
| `test` | the pure logic |

The secret scan runs first because a credential leak is the worst outcome
available and the only failure no later gate would catch.

### What the secret gate does

It scans `git ls-files`, so it reads **exactly what would be pushed** and nothing
else. That matters twice: the 845 vendored documentation files stay out of scope
automatically, because they legitimately contain example keys in code samples,
and a file that is only in your working tree cannot be reported as a leak.

It checks three things:

1. **No forbidden file is tracked.** Every `.env.<suffix>` is forbidden except
   `.env.example`, `.env.template`, and `.env.sample`, matched on the basename so
   a nested `apps/api/.env.local` is caught too. So are private keys, credential
   JSON, and `temp_login.json`.
2. **No known provider credential shape.** Telnyx API keys and webhook tokens,
   Clerk keys, JWTs (which is what a Twenty API key is), AWS and GitHub tokens,
   Slack tokens, Stripe live keys, and database URLs carrying a password.
3. **No plausible secret assigned to a credential-shaped name**, unless the value
   is an obvious placeholder.

Findings are redacted in the log, as `KEY0…0p`, never the whole value.

The third rule leans on a placeholder allowlist rather than a secret allowlist, so
a genuinely new credential is caught by default and a false positive has to be
argued for explicitly.

### Why the scanner has its own self-test

`pnpm run check:secrets:self-test` writes known-bad and known-good fixtures to a
temporary directory and checks the scanner separates them, so the gate is not
trusted on trust. It has already earned its place: the first version allowed any
bare `[a-z0-9-]` value as a placeholder, which also matches a hex API key, so a
real credential of that shape passed. The self-test caught it.

## Sequence builder

A sequence is a sending number, a campaign, a set of options, and an ordered
list of steps. Build it, dry-run it, then turn it on.

```bash
# Check a draft and get every problem at once
echo '{"name":"Spring outreach","fromNumber":"+353871234567",
       "campaignId":"cmp_123",
       "options":{"dailyCapPerRecipient":2},
       "steps":[{"text":"Hi, noticed your work in Cork.","delayHours":0,"isStop":false},
                {"text":"Following up in two days.","delayHours":48,"isStop":false},
                {"text":"","delayHours":96,"isStop":true}]}' \
  | blaster sequence validate
# Valid. 2 sending step(s) across 48h, with a stop condition.
```

Dry runs need no Telnyx credentials, because they send nothing:

```bash
echo "$DRAFT" | blaster sequence preview --recipients '[
  {"id":"p-ie","to":"+353871234567","country":"IE"},
  {"id":"p-us","to":"+14155552671","country":"US"},
  {"id":"p-de","to":"+4915112345678","country":"DE"},
  {"id":"p-dnc","to":"+353871234568","country":"IE","doNotContact":true}]'
# 2 of 4 recipient(s) would receive the next step.
#   [send] p-ie    profile-ie-alpha
#   [send] p-us    profile-us-10dlc
#   [skip] p-de    no-profile-for-country
#   [skip] p-dnc   do-not-contact
```

Drafts are also recorded locally, so a sequence can be built once and reused:

```bash
blaster sequence new "Spring outreach"   # interactive build, then recorded
blaster sequence list                    # what is recorded
blaster sequence show "Spring outreach"  # steps plus a per-recipient plan
blaster sequence edit "Spring outreach"  # change the first message
blaster sequence run "Spring outreach"   # dry run against the recorded draft
blaster sequence rm "Spring outreach"    # forget it
```

Recorded drafts live in `.blaster/sequences.json`, next to the session file.
`run` is a dry run over the recorded draft: it prints the compliance plan and
names what the runner still needs. See [docs/sequencer.md](docs/sequencer.md)
for what is finished, what is not, and the exact gaps.

The same operations are on all three surfaces:

| Surface | Validate | Dry run |
| --- | --- | --- |
| CLI | `blaster sequence validate` | `blaster sequence preview` |
| MCP | `blaster_validate_sequence` | `blaster_preview_sequence` |
| HTTP | `POST /api/sequences/validate` | `POST /api/sequences/preview` |

### Options

| Option | Default | What it does |
| --- | --- | --- |
| `stopOnReply` | `true` | Stops the sequence as soon as the recipient replies |
| `respectDoNotContact` | `true` | Never sends to an opted-out prospect |
| `requireProfileForCountry` | `true` | Skips a recipient whose country has no registered profile, instead of sending from the default and letting the carrier reject it |
| `dailyCapPerRecipient` | `0` | Ceiling on messages per recipient per day. `0` means no cap |

### Why eligibility is checked twice

Once in the dry run, so an operator sees who is skipped before turning anything
on, and again at send time, because a recipient can opt out between the two. The
send-time check is the one that counts; the dry run is a preview of it.

A skip never advances the cursor. The step is still owed and the reason is
recorded, so an operator can either fix the cause or pause the sequence rather
than silently losing the message.

See [docs/diagrams/sequence-builder.mmd](docs/diagrams/sequence-builder.mmd).

## Documentation

- [docs/README.md](docs/README.md) — authored versus vendored, and the
  suite-to-library map for the 845 files of upstream docs on disk
- [docs/architecture.md](docs/architecture.md) — how the two runtimes split, the
  Twenty sharp edges, and the profile rules
- [docs/naming-conventions.md](docs/naming-conventions.md) — the required
  directory structure
- [docs/diagrams/](docs/diagrams/) — ten Mermaid diagrams covering the system
  overview, profile resolution, the breakdown and notification flow, the data
  model, the send sequence, the sequence builder, Twenty auth paths,
  deployment, and the gates
- [docs/sequencer.md](docs/sequencer.md) — the multi-step sequencer: what is
  finished, what is not, and the exact gaps before a draft can run itself

## Diagrams

The two decisions worth seeing before reading code. The full set is in
[docs/diagrams/](docs/diagrams/).

**Profile resolution, which happens before every send:**

```mermaid
flowchart TD
  START["Send one SMS"] --> BOUND{"Sending number<br/>declares a profile?"}
  BOUND -- "yes" --> BOUNDWIN["Use the bound profile<br/>bound-to-number"]
  BOUND -- "no" --> PARSE["Resolve the recipient country<br/>libphonenumber-js"]
  PARSE --> MAP{"Country registered in<br/>TELNYX_MESSAGING_PROFILES?"}
  MAP -- "yes" --> HIT["Use the country profile<br/>recipient-country"]
  MAP -- "no" --> DEFAULT{"Default set?"}
  DEFAULT -- "yes" --> WARN["Default profile, plus a warning<br/>naming the variable to set"]
  DEFAULT -- "no" --> NONE["Refuse to send<br/>no-profile-configured"]
  BOUNDWIN --> SEND["POST /v2/messages"]
  HIT --> SEND
  WARN --> SEND

  classDef good fill:#0f2a1c,stroke:#4ade80,color:#f5f7ff
  classDef warn fill:#2a1f0f,stroke:#fbbf24,color:#f5f7ff
  classDef stop fill:#2a0f0f,stroke:#f87171,color:#f5f7ff
  class HIT,BOUNDWIN good
  class WARN warn
  class NONE stop
```

**From Twenty rows to a notification that is delivered once:**

```mermaid
flowchart TD
  READ["Read agencyLeads and agencyCalls"] --> BUILD["buildBreakdown<br/>pure"]
  BUILD --> RULES["evaluateNotifications<br/>thresholds over the breakdown"]
  RULES --> KEY["stateKey is the sorted set<br/>of firing rule ids"]
  KEY --> SEEN{"Already delivered?"}
  SEEN -- "yes" --> SUPPRESS["Suppress. Do not re-announce<br/>an unchanged condition."]
  SEEN -- "no" --> RECORD["recordNotification<br/>keyed by stateKey"]
  RECORD --> DELIVER["Deliver once"]

  classDef pure fill:#0f1f2a,stroke:#5ee7ff,color:#f5f7ff
  class BUILD,RULES pure
```

