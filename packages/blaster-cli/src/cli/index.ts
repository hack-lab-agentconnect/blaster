/**
 * Blaster CLI.
 *
 * Argument parsing is hand-rolled and the shape of a failure is deliberate:
 * every command returns a machine-parsable `command failed (kind): message`
 * so a script can branch on the kind instead of scraping prose.
 *
 * The CLI is a thin shell over @blaster/core. It holds no business rules of
 * its own, so the same answers come from the HTTP surface and the MCP server.
 */

import {
  TwentyClient,
  buildBreakdown,
  describeEnv,
  evaluateNotifications,
  missingRequired,
  notificationStateKey,
  resolveMessagingProfile,
  sendMessage,
  uncoveredCountries,
  type Breakdown,
  type TwentyRecord,
} from "@blaster/core";

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command, positional, flags };
}

const USAGE = `Usage: blaster <command> [options]

Read and act on the pipeline.

  breakdown                    Counts, rates, and the notifications they trigger
  prospects <object>           List records from a Twenty object
  env                          Every variable, whether it is set, and who reads it
  profile --to <number>        The messaging profile a recipient resolves to
  send --to <number> --from <number> --text <text>
                               Send one SMS on the recipient's profile
  capabilities                 Every capability and the surface that implements it

Options
  --json                       Machine-readable output
  --limit <n>                  Page size for prospects (max 200)
  --filter <dsl>               Twenty filter, e.g. status[eq]:CONVERTED

Run "blaster help" for this text.`;

const CAPABILITIES = [
  { id: "pipeline.breakdown", cli: "blaster breakdown", mcp: "blaster_breakdown", http: "GET /api/breakdown" },
  { id: "env.describe", cli: "blaster env", mcp: "blaster_env", http: "GET /api/env" },
  { id: "messaging.profile", cli: "blaster profile", mcp: "blaster_messaging_profile", http: "GET /api/messaging/profile" },
  { id: "messaging.send", cli: "blaster send", mcp: "blaster_send_message", http: "POST /api/messages/send" },
  { id: "prospects.list", cli: "blaster prospects", mcp: "blaster_list_records", http: "GET /api/records/:object" },
] as const;

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function twentyOrFail(): Promise<TwentyClient> {
  const missing = ["TWENTY_BASE_URL", "TWENTY_API_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`configuration: ${missing.join(", ")} not set`);
  }
  return new TwentyClient();
}

async function readBreakdown(): Promise<Breakdown> {
  const client = await twentyOrFail();
  const [leads, calls] = await Promise.all([
    client.listAll<TwentyRecord>("agencyLeads"),
    client.listAll<TwentyRecord>("agencyCalls"),
  ]);
  return buildBreakdown({ leads, calls });
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const json = flags.get("json") === true;

  switch (command) {
    case undefined:
    case "help":
    case "--help": {
      console.log(USAGE);
      return 0;
    }

    case "capabilities": {
      console.log(json ? asJson(CAPABILITIES) : formatCapabilities());
      return 0;
    }

    case "env": {
      const payload = {
        variables: describeEnv().map((variable) => ({
          name: variable.name,
          required: variable.required,
          configured: variable.configured,
          consumedBy: variable.consumedBy,
        })),
        missingRequired: missingRequired(),
        uncoveredMessagingProfileCountries: uncoveredCountries(process.env),
      };
      console.log(json ? asJson(payload) : formatEnv(payload));
      return payload.missingRequired.length > 0 ? 1 : 0;
    }

    case "breakdown": {
      const breakdown = await readBreakdown();
      const notifications = evaluateNotifications(breakdown);
      const payload = { breakdown, notifications, stateKey: notificationStateKey(notifications) };
      console.log(json ? asJson(payload) : formatBreakdown(payload));
      return 0;
    }

    case "prospects": {
      const object = positional[0];
      if (!object) {
        console.error("blaster prospects: object required (for example agencyLeads)\n" + USAGE);
        return 1;
      }
      const limitRaw = flags.get("limit");
      const limit = typeof limitRaw === "string" ? Number(limitRaw) : undefined;
      const filter = typeof flags.get("filter") === "string" ? (flags.get("filter") as string) : undefined;
      const client = await twentyOrFail();
      const records = await client.listAll<TwentyRecord>(object, { limit, filter });
      console.log(json ? asJson(records) : formatRecords(object, records));
      return 0;
    }

    case "profile": {
      const to = typeof flags.get("to") === "string" ? (flags.get("to") as string) : positional[0];
      const country = typeof flags.get("country") === "string" ? (flags.get("country") as string) : undefined;
      const resolution = resolveMessagingProfile(process.env, { to, recipientCountry: country });
      console.log(json ? asJson(resolution) : formatResolution(resolution));
      return resolution.profileId ? 0 : 1;
    }

    case "send": {
      const to = flags.get("to") as string | undefined;
      const from = flags.get("from") as string | undefined;
      const text = flags.get("text") as string | undefined;
      if (!to || !text) {
        console.error("blaster send: --to and --text are required\n" + USAGE);
        return 1;
      }
      if (!from) {
        // Blaster will not guess a sending number: the wrong one sends from the
        // wrong jurisdiction and the carrier rejects it after acceptance.
        console.error("blaster send: --from is required; Blaster will not guess a sending number");
        return 1;
      }
      const apiKey = process.env.TELNYX_API_KEY;
      if (!apiKey) {
        console.error("blaster send failed (configuration): TELNYX_API_KEY not set");
        return 1;
      }
      const resolution = resolveMessagingProfile(process.env, { to });
      if (!resolution.profileId) {
        console.error("blaster send failed (configuration): no messaging profile is configured");
        return 1;
      }
      const sent = await sendMessage({
        apiKey,
        from,
        to,
        text,
        messagingProfileId: resolution.profileId,
      });
      console.log(json ? asJson({ sent, resolution }) : `Sent ${sent.id} (${sent.status}) from ${from} to ${to} on profile ${resolution.profileId ?? "none"}.`);
      if (resolution.warning) console.error(`warning: ${resolution.warning}`);
      return 0;
    }

    default: {
      console.error(`blaster: unknown command "${command}"\n${USAGE}`);
      return 1;
    }
  }
}

function formatCapabilities(): string {
  const width = Math.max(...CAPABILITIES.map((capability) => capability.id.length));
  return CAPABILITIES.map(
    (capability) => `${capability.id.padEnd(width)}  cli: ${capability.cli}  mcp: ${capability.mcp}  http: ${capability.http}`,
  ).join("\n");
}

function formatEnv(payload: {
  variables: Array<{ name: string; required: boolean; configured: boolean; consumedBy: string[] }>;
  missingRequired: string[];
  uncoveredMessagingProfileCountries: string[];
}): string {
  const lines = payload.variables.map(
    (variable) =>
      `${variable.configured ? "set    " : "unset  "}${variable.required ? "required" : "optional"}  ${variable.name}`,
  );
  if (payload.missingRequired.length > 0) {
    lines.push("", `Missing required: ${payload.missingRequired.join(", ")}`);
  }
  if (payload.uncoveredMessagingProfileCountries.length > 0) {
    lines.push(
      `Countries with no messaging profile: ${payload.uncoveredMessagingProfileCountries.join(", ")}`,
    );
  }
  return lines.join("\n");
}

function formatBreakdown(payload: {
  breakdown: Breakdown;
  notifications: Array<{ severity: string; message: string }>;
  stateKey: string;
}): string {
  const { breakdown } = payload;
  const lines = [
    `Leads: ${breakdown.leads.total}`,
    ...breakdown.leads.byStatus
      .filter((slice) => slice.count > 0)
      .map((slice) => `  ${slice.label.padEnd(16)} ${String(slice.count).padStart(5)}  ${slice.share}%`),
    "",
    `Calls: ${breakdown.calls.total}  answered ${breakdown.calls.answered} (${breakdown.calls.answerRate}%)  avg ${breakdown.calls.averageDurationSeconds}s`,
    ...breakdown.calls.byOutcome
      .filter((slice) => slice.count > 0)
      .map((slice) => `  ${slice.label.padEnd(16)} ${String(slice.count).padStart(5)}  ${slice.share}%`),
    "",
    `Conversion: ${breakdown.conversion.rate}% (${breakdown.conversion.converted})`,
  ];

  if (payload.notifications.length > 0) {
    lines.push("", "Notifications:");
    for (const notification of payload.notifications) {
      lines.push(`  [${notification.severity}] ${notification.message}`);
    }
  } else {
    lines.push("", "Notifications: none firing.");
  }
  return lines.join("\n");
}

function formatRecords(object: string, records: TwentyRecord[]): string {
  if (records.length === 0) return `${object}: no records.`;
  const lines = records.map((record, index) => `${String(index + 1).padStart(4)}. ${record.id}  ${describeRecord(record)}`);
  return [`${object}: ${records.length} record(s)`, ...lines].join("\n");
}

function describeRecord(record: TwentyRecord): string {
  const parts: string[] = [];
  if (typeof record.name === "string") parts.push(record.name);
  if (typeof record.status === "string") parts.push(`status=${record.status}`);
  if (typeof record.outcome === "string") parts.push(`outcome=${record.outcome}`);
  return parts.join("  ");
}

function formatResolution(resolution: {
  profileId: string | null;
  reason: string;
  country: string | null;
  warning?: string;
}): string {
  const lines = [
    `country:  ${resolution.country ?? "unresolved"}`,
    `profile:  ${resolution.profileId ?? "none configured"}`,
    `reason:   ${resolution.reason}`,
  ];
  if (resolution.warning) lines.push(`warning:  ${resolution.warning}`);
  return lines.join("\n");
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // The machine-parsable form, so a caller can branch on the kind.
    const kind = error instanceof Error ? error.name : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    console.error(`blaster failed (${kind}): ${message}`);
    process.exitCode = 1;
  });
