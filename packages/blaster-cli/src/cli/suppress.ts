/**
 * `blaster suppress`: the durable, per-person do-not-contact list.
 *
 * A STOP is a fact about the person, not the enrollment, so it holds across
 * every sequence and every pool number. This is the operator's view of that
 * list, and the only way to lift an entry — nothing in the inbound path can,
 * which is what makes an unsubscribe actually stick.
 *
 * Scriptable and prompt-free, like the rest of the operator commands: it reads
 * the session gate through `ensureLiveSession` rather than the stored token.
 */

import {
  BlasterApiError,
  createBlasterApiClient,
  type BlasterApiClient,
  type SuppressionRow,
} from "@blaster/core";
import { ensureLiveSession, loadHome, loginMain } from "./login.ts";
import type { CliFlags } from "./inbox.ts";
import { isInteractive } from "./prompt.ts";

export const SUPPRESS_USAGE = `Usage: blaster suppress <action>

  list                          Everyone currently suppressed, newest first
  add --peer <e164> [--reason <text>]
                                Suppress a person by hand
  remove --peer <e164>          Lift a suppression (the only way to reopen contact)

A suppression is durable and keyed on the person: a STOP recorded once stops
every sequence and every pool number, until it is lifted here. An inbound START
does not lift it.

Options
  --api-url <url>               The API to read, defaulting to the signed-in one
  --json                        Machine-readable output

Reads the operator session written by "blaster login".`;

async function liveClient(flags: CliFlags, json: boolean, root: string): Promise<BlasterApiClient | number> {
  const home = loadHome(root);
  const explicit = typeof flags.get("api-url") === "string" ? (flags.get("api-url") as string) : null;
  const apiUrl =
    (explicit !== null && explicit !== "" ? explicit : null) ??
    home.config.apiUrl ??
    Object.keys(home.sessions)[0] ??
    null;
  if (!apiUrl) {
    console.error('blaster suppress: no signed-in API. Run "blaster login" first, or pass --api-url.');
    return 1;
  }
  let session = await ensureLiveSession(root, apiUrl);
  if (!session) {
    if (!isInteractive(json)) {
      console.error(`blaster suppress: no live session for ${apiUrl}. Run "blaster login" first.`);
      return 1;
    }
    const code = await loginMain(new Map([["api-url", apiUrl]]), json, root);
    if (code !== 0) return code;
    session = await ensureLiveSession(root, apiUrl);
    if (!session) {
      console.error(`blaster suppress: no live session for ${apiUrl}. Run "blaster login" first.`);
      return 1;
    }
  }
  return createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken });
}

function report(error: unknown, json: boolean): number {
  if (error instanceof BlasterApiError) {
    if (error.kind === "unauthorized") {
      const message = 'The operator token is not accepted. Run "blaster login" again.';
      console.error(json ? JSON.stringify({ error: message, kind: error.kind }, null, 2) : `blaster suppress: ${message}`);
      return 1;
    }
    console.error(json ? JSON.stringify({ error: error.message, kind: error.kind, status: error.status }, null, 2) : `blaster suppress: ${error.message} (${error.status})`);
    return error.kind === "unavailable" || error.kind === "server" ? 2 : 1;
  }
  console.error(`blaster suppress: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
}

const asJson = (value: unknown): string => JSON.stringify(value, null, 2);
const text = (value: string | boolean | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

function formatList(rows: SuppressionRow[]): string {
  if (rows.length === 0) return "Nobody is suppressed.";
  return rows
    .map(
      (row) =>
        `${row.peer}  [${row.source}]  ${new Date(row.createdAt).toISOString()}` +
        (row.reason ? `  ${row.reason}` : ""),
    )
    .join("\n");
}

export async function suppressMain(
  rest: string[],
  flags: CliFlags,
  json: boolean,
  root: string = process.cwd(),
): Promise<number> {
  const action = rest[0];
  if (action === "help") {
    console.log(SUPPRESS_USAGE);
    return 0;
  }
  const client = await liveClient(flags, json, root);
  if (typeof client === "number") return client;

  try {
    switch (action) {
      case "list":
      case "ls": {
        const rows = await client.listSuppressions();
        console.log(json ? asJson({ count: rows.length, suppressions: rows }) : formatList(rows));
        return 0;
      }
      case "add":
      case "suppress": {
        const peer = text(flags.get("peer")) ?? rest[1];
        if (!peer) {
          console.error(`blaster suppress add: --peer is required\n${SUPPRESS_USAGE}`);
          return 1;
        }
        const result = await client.setSuppression({
          peer,
          suppressed: true,
          ...(text(flags.get("reason")) === undefined ? {} : { reason: text(flags.get("reason")) as string }),
        });
        console.log(json ? asJson(result) : result.changed ? `Suppressed ${result.peer}.` : `${result.peer} was already suppressed.`);
        return 0;
      }
      case "remove":
      case "lift":
      case "rm": {
        const peer = text(flags.get("peer")) ?? rest[1];
        if (!peer) {
          console.error(`blaster suppress remove: --peer is required\n${SUPPRESS_USAGE}`);
          return 1;
        }
        const result = await client.setSuppression({ peer, suppressed: false });
        console.log(json ? asJson(result) : result.changed ? `Lifted the suppression on ${result.peer}.` : `${result.peer} was not suppressed.`);
        return 0;
      }
      default: {
        console.error(`blaster suppress: unknown action "${action}"\n${SUPPRESS_USAGE}`);
        return 1;
      }
    }
  } catch (error) {
    return report(error, json);
  }
}
