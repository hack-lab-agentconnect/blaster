/**
 * `blaster send`.
 *
 * The write side of a conversation, and the reason the CLI exists as a client
 * rather than a script. It goes through the same shared `createBlasterApiClient`
 * as `blaster inbox`, using the operator session from `blaster login`, so a send
 * from the terminal is the same authenticated call MCP and the HTTP surface make
 * rather than a second implementation that can disagree with them.
 *
 * That matters more for a send than for a read. The Telnyx key stays on the API,
 * where it belongs, and the profile comes from the sending number's own
 * `agencyPhones` record, so this command cannot send from the wrong registration:
 * it never sees a profile id to get wrong.
 *
 * Two modes. A complete one-recipient invocation sends exactly one message and
 * never prompts. Anything else at a terminal starts the guided flow: pick a
 * sending number from the workspace, filter prospects from the Twenty schema,
 * preview eligibility, confirm the exact send, and batch through the API with
 * per-recipient outcomes. Pipelines use explicit batch flags plus `--yes` and
 * never prompt; missing pieces there are an error naming the shape.
 */

import {
  BlasterApiError,
  createBlasterApiClient,
  type BatchSendResult,
  type BlasterApiClient,
  type ProspectFilter,
  type SendResolution,
  type SentMessage,
} from "@blaster/core";
import { randomUUID } from "node:crypto";
import { ensureLiveSession, loadHome, loginMain, type SessionRecord } from "./login.ts";
import { abort, askConfirm, askSelect, askText, begin, finish, isInteractive } from "./prompt.ts";
import type { CliFlags } from "./inbox.ts";

export const SEND_USAGE = `Usage: blaster send <to> [from] <text>

  blaster send +15551234567 "Thanks, that works."
  blaster send +15551234567 +15557654321 "Thanks, that works."

  <to>      Recipient, E.164
  [from]    Sending number. Optional only when the workspace owns exactly one,
            in which case that number is used and Blaster says which.
  <text>    The message. Quote it so the shell keeps it as one argument.

Batch mode (prospects, scripted):

  blaster send --agency-phone-id <id> --filter '<json>' --text <string> --yes

  --agency-phone-id  Sending number id, from the guided flow or the API
  --filter           JSON array of {field, operator, value} clauses
  --text             The message
  --yes              Required: without it nothing sends

Options
  --to <e164>       Same as the first positional
  --from <e164>     Same as the optional second positional
  --text <string>   Same as the final positional
  --api-url <url>   The API to send through, defaulting to the signed-in one
  --json            Machine-readable output

At a terminal with missing arguments, send starts the guided flow instead of
prompting for one recipient. Uses the operator session written by
"blaster login". The profile is read from the sending number's record in
Twenty; there is no way to pass one by hand.`;

/**
 * The API client for the operator's signed-in API.
 *
 * Required rather than optional, and for a stronger reason than on the read side:
 * this route spends money and sends a real message to a real person. There is no
 * anonymous path, so a typo cannot become an unpaid-for send from whatever
 * server happened to answer.
 */
function clientFromSession(flags: CliFlags, root: string): BlasterApiClient | number {
  const home = loadHome(root);
  const explicit = typeof flags.get("api-url") === "string" ? (flags.get("api-url") as string) : null;
  const apiUrl = explicit ?? home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
  if (!apiUrl) {
    console.error('blaster send: no signed-in API. Run "blaster login" first, or pass --api-url.');
    return 1;
  }
  const session: SessionRecord | undefined = home.sessions[apiUrl];
  if (!session) {
    console.error(`blaster send: no session for ${apiUrl}. Run "blaster login" first.`);
    return 1;
  }
  return createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken });
}

function report(error: unknown, json: boolean): number {
  if (error instanceof BlasterApiError) {
    if (error.kind === "unauthorized") {
      const message = 'The operator token is not accepted. Run "blaster login" again.';
      console.error(json ? JSON.stringify({ error: message, kind: error.kind }, null, 2) : `blaster send: ${message}`);
      return 1;
    }
    // A 409 here is the interesting one: the sending number exists in the
    // workspace but has no profile on its record, which is a fixable setup
    // problem rather than a transient failure, so it exits 1 and not 2.
    const detail = `blaster send: ${error.message} (${error.status})`;
    console.error(json ? JSON.stringify({ error: error.message, kind: error.kind, status: error.status }, null, 2) : detail);
    return error.kind === "unavailable" || error.kind === "server" ? 2 : 1;
  }
  console.error(`blaster send: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * Read the recipient, sending number and body out of flags and positionals.
 *
 * The positional shape is `send <to> [from] <text>`, which is ambiguous by
 * nature: two arguments could be a recipient and a body, or a recipient, a
 * number and a body. A leading `+` settles it, because that is the one form
 * E.164 has and a message cannot start with, so an unclaimed argument in that
 * shape is the sending number. Flags win over positionals.
 *
 * Only these three keys can come out. A caller cannot name a profile or a
 * messaging profile id, because those belong to the sending number's
 * registration and the API reads them from Twenty. Anything else passed as a flag
 * is ignored rather than forwarded, so no surface can talk the API into using a
 * registration of its choosing.
 */
export function parseSendArgs(
  positional: string[],
  flags: CliFlags,
): { to?: string; from?: string; text?: string } {
  const flagText = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  let to = flagText("to");
  let from = flagText("from");
  let text = flagText("text");
  const rest = [...positional];
  if (to === undefined && rest.length > 0) to = rest.shift();

  // A second `+`-prefixed argument is the sender, but only when something else is
  // left to be the body. Otherwise `send <to> <body>` where the body happens to
  // begin with a plus would lose its message.
  if (
    from === undefined &&
    rest.length > 0 &&
    /^\+[1-9]\d{6,14}$/.test(rest[0] as string) &&
    (text !== undefined || rest.length >= 2)
  ) {
    from = rest.shift();
  }
  if (text === undefined && rest.length > 0) text = rest.join(" ");
  return { to, from, text };
}

/**
 * Scripted batch arguments. All four are required together and nothing
 * prompts: a pipeline missing any of them gets the usage, not a hang.
 */
interface BatchArgs {
  agencyPhoneId?: string;
  filtersRaw?: string;
  text?: string;
  yes: boolean;
  any: boolean;
}

function readBatchArgs(flags: CliFlags): BatchArgs {
  const text = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const agencyPhoneId = text("agency-phone-id");
  const filtersRaw = text("filter");
  const batchText = text("text");
  return {
    agencyPhoneId,
    filtersRaw,
    text: batchText,
    yes: flags.get("yes") === true,
    any: agencyPhoneId !== undefined || filtersRaw !== undefined,
  };
}

function parseFilterJson(raw: string): { filters?: ProspectFilter[]; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "--filter must be a JSON array of {field, operator, value} clauses" };
  }
  if (!Array.isArray(parsed)) return { error: "--filter must be a JSON array of {field, operator, value} clauses" };
  return { filters: parsed as ProspectFilter[] };
}

function resolveApiUrlForSend(flags: CliFlags, root: string): string | null {
  const explicit = flags.get("api-url");
  if (typeof explicit === "string" && explicit !== "") return explicit;
  const home = loadHome(root);
  return home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
}

/**
 * A live session, signing in first when a human is watching.
 *
 * Non-interactive callers never reach a browser: without a live session the
 * answer is the sign-in error, not a hang. After an interactive login the
 * session is re-read rather than trusted from before, because login is what
 * just wrote it.
 */
async function liveSession(
  flags: CliFlags,
  json: boolean,
  root: string,
): Promise<{ client: BlasterApiClient; apiUrl: string } | number> {
  const apiUrl = resolveApiUrlForSend(flags, root);
  if (!apiUrl) {
    console.error('blaster send: no signed-in API. Run "blaster login" first, or pass --api-url.');
    return 1;
  }
  let session = await ensureLiveSession(root, apiUrl);
  if (!session) {
    if (!isInteractive(json)) {
      console.error(`blaster send: no live session for ${apiUrl}. Run "blaster login" first.`);
      return 1;
    }
    const code = await loginMain(new Map([["api-url", apiUrl]]) as CliFlags, json, root);
    if (code !== 0) return code;
    session = await ensureLiveSession(root, apiUrl);
    if (!session) {
      console.error(`blaster send: no live session for ${apiUrl}. Run "blaster login" first.`);
      return 1;
    }
  }
  return { client: createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken }), apiUrl };
}

function formatBatch(result: BatchSendResult): string {
  const lines = [
    `Batch complete: ${result.sent} sent, ${result.skipped} skipped, ${result.failed} failed (from ${result.from})`,
  ];
  for (const outcome of result.outcomes) {
    if (outcome.status === "sent") continue;
    lines.push(`  ${outcome.status} ${outcome.phone ?? outcome.prospectId}: ${outcome.detail ?? "no detail"}`);
  }
  return lines.join("\n");
}

/** Scripted batch: every argument present, `--yes` set, zero prompts. */
async function batchSendMain(
  flags: CliFlags,
  json: boolean,
  root: string,
  batch: BatchArgs,
): Promise<number> {
  if (!batch.agencyPhoneId || batch.filtersRaw === undefined || !batch.text || !batch.yes) {
    console.error(
      "blaster send: batch mode needs --agency-phone-id, --filter, --text, and --yes\n" + SEND_USAGE,
    );
    return 1;
  }
  const parsed = parseFilterJson(batch.filtersRaw);
  if (!parsed.filters) {
    console.error(`blaster send: ${parsed.error}\n${SEND_USAGE}`);
    return 1;
  }
  const live = await liveSession(flags, json, root);
  if (typeof live === "number") return live;
  try {
    const result = await live.client.sendToProspects({
      agencyPhoneId: batch.agencyPhoneId,
      filters: parsed.filters,
      text: batch.text,
      idempotencyKey: randomUUID(),
    });
    console.log(json ? asJson(result) : formatBatch(result));
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    return report(error, json);
  }
}

/** Complete one-recipient invocation: exactly one message, never a prompt. */
async function oneShotSend(
  flags: CliFlags,
  json: boolean,
  root: string,
  single: { to: string; from?: string; text: string },
): Promise<number> {
  const client = clientFromSession(flags, root);
  if (typeof client === "number") return client;
  try {
    const { sent, resolution } = await client.sendMessage(
      single.from ? { to: single.to, from: single.from, text: single.text } : { to: single.to, text: single.text },
    );
    console.log(json ? asJson({ sent, resolution }) : formatSend(sent, resolution));
    return 0;
  } catch (error) {
    return report(error, json);
  }
}

/**
 * Guided send: number, filters, preview, confirm, batch. Only ever runs at
 * an interactive terminal; every network failure reports through the same
 * classifier the scripted paths use.
 */
async function guidedSend(flags: CliFlags, json: boolean, root: string, seedText?: string): Promise<number> {
  const live = await liveSession(flags, json, root);
  if (typeof live === "number") return live;
  const { client, apiUrl } = live;
  void apiUrl;
  begin("blaster send");
  try {
    const numbers = await client.listSendingNumbers();
    if (numbers.length === 0) {
      console.error(
        "blaster send: no sendable numbers. Set messagingProfileId on an agencyPhones record in Twenty first.",
      );
      return 1;
    }
    let agencyPhoneId: string;
    let from: string;
    const only = numbers.length === 1 ? numbers[0] : undefined;
    if (only) {
      agencyPhoneId = only.agencyPhoneId;
      from = only.phoneNumber;
      console.log(`Sending number: ${only.label}.`);
    } else {
      const picked = await askSelect(
        "Sending number?",
        numbers.map((row) => ({ value: row.agencyPhoneId, label: row.label })),
      );
      if (!picked) return abort("nothing was sent,");
      const chosen = numbers.find((row) => row.agencyPhoneId === picked);
      if (!chosen) return abort("nothing was sent,");
      agencyPhoneId = chosen.agencyPhoneId;
      from = chosen.phoneNumber;
    }

    const fields = await client.listProspectFields();
    const filters: ProspectFilter[] = [];
    for (let clause = 0; clause < 5; clause += 1) {
      const fieldName = await askSelect("Filter prospects by?", [
        { value: "__done", label: "Done — search with these filters" },
        { value: "__all", label: "All prospects (no filter)" },
        ...fields.map((field) => ({ value: field.name, label: field.label })),
      ]);
      if (!fieldName) return abort("nothing was sent,");
      if (fieldName === "__done" || fieldName === "__all") break;
      const field = fields.find((candidate) => candidate.name === fieldName);
      if (!field) continue;
      // Render the human operator word, not the bare DSL token: "equals"
      // instead of "eq". The value is still the token, so the filter the
      // server validates is unchanged; only what the operator reads differs.
      const operator = await askSelect(
        `Operator for ${field.label}?`,
        field.filterOperators.map((token, index) => ({
          value: token,
          label: field.operatorLabels[index] ?? token,
        })),
      );
      if (!operator) return abort("nothing was sent,");
      const value = await askText(`Value for ${field.label}?`);
      if (value === null) return abort("nothing was sent,");
      filters.push({ field: field.name, operator, value });
    }

    let cursor: string | undefined;
    let shown = 0;
    let total = 0;
    for (;;) {
      const page = await client.searchProspects({ filters, cursor, limit: 20 });
      total = page.total;
      if (shown === 0) console.log(`${total} prospects match.`);
      for (const prospect of page.prospects) {
        console.log(`  ${prospect.name || "(unnamed)"} ${prospect.phone ?? "no phone"}`);
      }
      shown += page.prospects.length;
      if (!page.nextCursor || shown >= total) break;
      const more = await askConfirm(`Show more? (${shown} of ${total} shown)`, true);
      if (more === null) return abort("nothing was sent,");
      if (!more) break;
      cursor = page.nextCursor;
    }
    if (total === 0) {
      console.log("No prospects match those filters. Nothing to send.");
      return 0;
    }

    const text = seedText ?? (await askText("Message text?"));
    if (!text) return abort("nothing was sent,");

    const preview = await client.previewProspectSend({ agencyPhoneId, filters, text });
    console.log(`${preview.eligible} eligible, ${preview.skipped} skipped.`);
    for (const prospect of preview.sample) {
      console.log(`  ${prospect.name || "(unnamed)"} ${prospect.phone ?? "no phone"}`);
    }
    const confirmed = await askConfirm(`Send ${preview.eligible} messages from ${from}?`);
    if (confirmed === null) return abort("nothing was sent,");
    if (!confirmed) {
      console.log("Not sent.");
      return 0;
    }

    const result = await client.sendToProspects({
      agencyPhoneId,
      filters,
      text,
      idempotencyKey: randomUUID(),
    });
    console.log(formatBatch(result));
    finish(`Sent ${result.sent} of ${result.total}.`);
    return result.failed > 0 ? 1 : 0;
  } catch (error) {
    return report(error, json);
  }
}

export function formatSend(sent: SentMessage, resolution: SendResolution): string {
  const lines = [
    `Sent ${sent.id}`,
    `  from     ${sent.from}`,
    `  to       ${sent.to}`,
    `  status   ${sent.status}`,
    `  profile  ${resolution.profileId ?? "none"} (${resolution.reason})`,
  ];
  if (resolution.warning) lines.push(`  warning  ${resolution.warning}`);
  return lines.join("\n");
}

export async function sendMain(
  positional: string[],
  flags: CliFlags,
  json: boolean,
  root: string = process.cwd(),
): Promise<number> {
  const batch = readBatchArgs(flags);
  if (batch.any) return await batchSendMain(flags, json, root, batch);
  const single = parseSendArgs(positional, flags);
  if (single.to !== undefined && single.text !== undefined) {
    return await oneShotSend(flags, json, root, single as { to: string; from?: string; text: string });
  }
  if (!isInteractive(json)) {
    console.error("blaster send: a recipient and a message are required\n" + SEND_USAGE);
    return 1;
  }
  return await guidedSend(flags, json, root, single.text);
}
