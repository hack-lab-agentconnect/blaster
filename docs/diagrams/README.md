# Diagrams

Mermaid sources for the Blaster architecture. Each file is a standalone
`.mmd`; the ones that matter are also embedded in the [README](../../README.md)
and in [architecture.md](../architecture.md).

| Diagram | What it shows |
| --- | --- |
| [system-overview.mmd](system-overview.mmd) | The whole system: three surfaces, the domain library, the Convex backend with its mounted components, and the two external providers |
| [surfaces-and-core.mmd](surfaces-and-core.mmd) | Why the domain library is separate, and the rule that a helper never imports its own domain barrel |
| [messaging-profile-resolution.mmd](messaging-profile-resolution.mmd) | The decision that has to happen before a send: bound number, then country, then default, with an unregistered country reported rather than absorbed |
| [breakdown-and-notifications.mmd](breakdown-and-notifications.mmd) | Twenty rows to counts to firing notifications, and the state key that stops a poller repeating an unchanged condition |
| [data-model.mmd](data-model.mmd) | Where state lives: Twenty as the system of record, Convex holding only what Twenty cannot represent |
| [send-message-sequence.mmd](send-message-sequence.mmd) | One message end to end, including the inbound webhook and the honest verification branch |
| [deployment-and-gates.mmd](deployment-and-gates.mmd) | What ships to railcode.dev and Convex Cloud, and the pre-push gates in the order they run |

## Rendering

Any Mermaid renderer takes these directly. GitHub renders fenced `mermaid`
blocks, so a diagram embedded in a Markdown file is the same source as the file
here rather than a second copy that can drift.

## Keeping them honest

These describe code, so a diagram that no longer matches the code is a defect.
The two places that most often drift are the profile resolution order and the
set of tables in `convex/schema.ts`; both are pinned by tests, and a change to
either should come with a change to the matching diagram.
