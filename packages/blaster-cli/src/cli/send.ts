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
 * Scriptable, and prompt-free by default. A command that blocks on a prompt is
 * unusable from a pipeline, so the recipient and body are positional arguments
 * and a missing one is a message naming the shape rather than a hang. The
 * interactive prompts are kept for a bare `blaster send` at a terminal, where
 * they are a convenience rather than a trap.
 */

import {
  BlasterApiError,
  createBlasterApiClient,
  type BlasterApiClient,
  type SendResolution,
  type SentMessage,
} from "@blaster/core";
import { loadHome, type SessionRecord } from "./login.ts";
import { abort, askText, begin, finish, isInteractive } from "./prompt.ts";
import type { CliFlags } from "./inbox.ts";

export const SEND_USAGE = `Usage: blaster send <to> [from] <text>

  blaster send +15551234567 "Thanks, that works."
  blaster send +15551234567 +15557654321 "Thanks, that works."

  <to>      Recipient, E.164
  [from]    Sending number. Optional only when the workspace owns exactly one,
            in which case that number is used and Blaster says which.
  <text>    The message. Quote it so the shell keeps it as one argument.

Options
  --to <e164>       Same as the first positional
  --from <e164>     Same as the optional second positional
  --text <string>   Same as the final positional
  --api-url <url>   The API to send through, defaulting to the signed-in one
  --json            Machine-readable output

Uses the operator session written by "blaster login". The profile is read from
the sending number's record in Twenty; there is no way to pass one by hand.`;

interface Prepared {
  client: BlasterApiClient;
  to: string;
  from: string | undefined;
  text: string;
  prompted: boolean;
}

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
 * Fill in whatever the arguments did not supply, or explain why it cannot.
 *
 * Only the interactive path prompts, so a pipeline gets an error naming the
 * missing argument instead of a hang waiting for input that will never come.
 */
async function gather(
  flags: CliFlags,
  positional: string[],
  json: boolean,
  root: string,
): Promise<Prepared | number> {
  const { to: givenTo, from: givenFrom, text: givenText } = parseSendArgs(positional, flags);
  let to = givenTo;
  let from = givenFrom;
  let text = givenText;

  let prompted = false;
  if (!to || !text) {
    if (!isInteractive(json)) {
      console.error("blaster send: a recipient and a message are required\n" + SEND_USAGE);
      return 1;
    }
    prompted = true;
    begin("blaster send");
    to = to ?? ((await askText("Recipient number?", { placeholder: "+15551234567" })) ?? undefined);
    if (!to) return abort("nothing was sent,");
    const typed = from ?? ((await askText("Sending number? (blank for the only number you own)")) ?? undefined);
    // An empty answer is not a number, and is the documented way to say "use the
    // one this workspace owns".
    from = typed === "" ? undefined : typed;
    text = text ?? ((await askText("Message text?")) ?? undefined);
    if (!text) return abort("nothing was sent,");
  }

  const client = clientFromSession(flags, root);
  if (typeof client === "number") return client;
  return { client, to, from, text, prompted };
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
  const prepared = await gather(flags, positional, json, root);
  if (typeof prepared === "number") return prepared;
  const { client, to, from, text, prompted } = prepared;
  try {
    const { sent, resolution } = await client.sendMessage(from ? { to, from, text } : { to, text });
    console.log(json ? asJson({ sent, resolution }) : formatSend(sent, resolution));
    if (prompted && !json) finish(`Sent ${sent.id}.`);
    return 0;
  } catch (error) {
    return report(error, json);
  }
}
