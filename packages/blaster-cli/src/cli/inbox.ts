/**
 * `blaster inbox list` and `blaster inbox show`.
 *
 * The read side of the conversation history, and the CLI's half of the parity
 * the terminal client will complete. Both go through the shared
 * `createBlasterApiClient`, so what a script reads here is byte-for-byte what
 * MCP returns for the same query, and neither can drift from the API's shape.
 *
 * Scriptable, and prompt-free. A command that blocks on a prompt is unusable
 * from a pipeline, so anything a script would have to supply is a required
 * argument and the failure is a message naming the flag rather than a hang.
 */

import {
  BlasterApiError,
  createBlasterApiClient,
  type BlasterApiClient,
  type ConversationMessageRow,
  type ConversationSummary,
} from "@blaster/core";
import { loadHome, type SessionRecord } from "./login.ts";


export const INBOX_USAGE = `Usage: blaster inbox list|show

  inbox list                    Conversations, newest activity first
  inbox show <conversation-id>  Every message in one thread, oldest first

Options
  --number <e164>               Only threads for this sending number
  --campaign <id>               Only threads in this campaign (resolves it, so slower)
  --limit <n>                   Page size (max 200)
  --api-url <url>               The API to read, defaulting to the signed-in one
  --json                       Machine-readable output

Reads the operator session written by "blaster login". Nothing here prompts.`;

/**
 * The parsed flag map. Declared here and imported by the dispatcher so the two
 * halves of the CLI cannot disagree about what a flag is.
 */
export type CliFlags = Map<string, string | boolean>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * The API client for the operator's signed-in API.
 *
 * A session is required rather than optional: the inbox carries prospect phone
 * numbers and message bodies, and the API checks the token on every call. There
 * is no anonymous path to fall back to, which is the point.
 */
function clientFromSession(flags: CliFlags, root: string): BlasterApiClient | number {
  const home = loadHome(root);
  const explicit = typeof flags.get("api-url") === "string" ? (flags.get("api-url") as string) : null;
  const apiUrl = explicit ?? home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
  if (!apiUrl) {
    console.error('blaster inbox: no signed-in API. Run "blaster login" first, or pass --api-url.');
    return 1;
  }
  const session: SessionRecord | undefined = home.sessions[apiUrl];
  if (!session) {
    console.error(`blaster inbox: no session for ${apiUrl}. Run "blaster login" first.`);
    return 1;
  }
  return createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken });
}

function report(error: unknown, json: boolean): number {
  if (error instanceof BlasterApiError) {
    if (error.kind === "unauthorized") {
      const message = "The operator token is not accepted. Run \"blaster login\" again.";
      console.error(json ? JSON.stringify({ error: message, kind: error.kind }, null, 2) : `blaster inbox: ${message}`);
      return 1;
    }
    const detail = `blaster inbox: ${error.message} (${error.status})`;
    console.error(json ? JSON.stringify({ error: error.message, kind: error.kind, status: error.status }, null, 2) : detail);
    return error.kind === "unavailable" || error.kind === "server" ? 2 : 1;
  }
  console.error(`blaster inbox: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);

const when = (ms: number): string => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/**
 * The list, formatted for a terminal.
 *
 * The preview is truncated to the terminal width rather than wrapped, because a
 * wrapped preview makes every row two lines and the list stops being scannable.
 */
export function formatConversationList(rows: ConversationSummary[]): string {
  if (rows.length === 0) return "No conversations yet. Inbound messages appear here once the webhook stores one.";
  const width = Math.max(24, Math.min(60, (process.stdout.columns ?? 100) - 40));
  const header = ["NUMBER", "MESSAGES", "LAST", "PREVIEW"].map((h, i) => (i === 0 ? h.padEnd(16) : i === 1 ? h.padEnd(9) : i === 2 ? h.padEnd(18) : h));
  const lines = rows.map((row) => {
    const count = String(row.messageCount).padEnd(9);
    const last = `${when(row.latestMessageAt)} ${row.latestDirection === "inbound" ? "<" : ">"}`.padEnd(18);
    const preview = (row.latestPreview ?? "(no text)").replace(/\s+/g, " ").slice(0, width);
    return `${row.phoneNumber.padEnd(16)}${count}${last}${preview}`;
  });
  return [header.join(" "), ...lines.map((l) => "  " + l)].join("\n");
}

export function formatThread(rows: ConversationMessageRow[]): string {
  if (rows.length === 0) return "This conversation has no messages.";
  return rows
    .map((row) => {
      const marker = row.direction === "inbound" ? "prospect" : "blaster";
      const status = row.status === "delivered" || row.status === "received" ? "" : ` (${row.status})`;
      const body = row.body.replace(/\s+/g, " ") || "(no text)";
      return `${when(row.sentAt)}  ${marker}${status}\n    ${body}`;
    })
    .join("\n\n");
}

export async function inboxList(
  flags: CliFlags,
  json: boolean,
  root: string = process.cwd(),
): Promise<number> {
  const client = clientFromSession(flags, root);
  if (typeof client === "number") return client;
  const limitRaw = flags.get("limit");
  const limit = typeof limitRaw === "string" ? Math.min(Math.max(Number(limitRaw) || DEFAULT_LIMIT, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const number = flags.get("number");
  const campaign = flags.get("campaign");
  try {
    const rows = await client.listConversations({
      limit,
      ...(typeof number === "string" ? { number } : {}),
      ...(typeof campaign === "string" ? { campaign } : {}),
    });
    console.log(json ? asJson({ count: rows.length, conversations: rows }) : formatConversationList(rows));
    return 0;
  } catch (error) {
    return report(error, json);
  }
}

export async function inboxShow(
  rest: string[],
  flags: CliFlags,
  json: boolean,
  root: string = process.cwd(),
): Promise<number> {
  const client = clientFromSession(flags, root);
  if (typeof client === "number") return client;
  const id = rest[0];
  if (!id) {
    console.error(`blaster inbox show needs a conversation id\n${INBOX_USAGE}`);
    return 1;
  }
  const limitRaw = flags.get("limit");
  const limit = typeof limitRaw === "string" ? Number(limitRaw) || undefined : undefined;
  try {
    const rows = await client.conversationMessages(id, limit);
    console.log(json ? asJson({ conversationId: id, count: rows.length, messages: rows }) : formatThread(rows));
    return 0;
  } catch (error) {
    return report(error, json);
  }
}
