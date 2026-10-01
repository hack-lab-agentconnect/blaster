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
  DEFAULT_OPTIONS,
  TwentyClient,
  buildBreakdown,
  canAgentRespond,
  classifyConversation,
  createNumberOrder,
  describeEnv,
  evaluateEligibility,
  evaluateNotifications,
  formatAgentReply,
  fromAgencyPhoneRecord,
  latestConfidence,
  listAgencyPhones,
  listOwnedNumbers,
  missingRequired,
  notificationStateKey,
  planPhoneSync,
  resolveMessagingProfile,
  searchAvailableNumbers,
  sendMessage,
  summarise,
  uncoveredCountries,
  upsertAgencyPhone,
  validateDraft,
  type Breakdown,
  type ConversationMessage,
  type NumberFeature,
  type NumberType,
  type Recipient,
  type ResolutionPath,
  type SequenceDraft,
  type TwentyRecord,
} from "@blaster/core";
import {
  abort,
  askConfirm,
  askSelect,
  askText,
  begin,
  finish,
  isInteractive,
  note,
} from "./prompt.ts";
import { LOGOUT_USAGE, WHOAMI_USAGE, loginMain, logoutMain, whoamiMain } from "./login.ts";
import { INBOX_USAGE, inboxList, inboxShow, type CliFlags } from "./inbox.ts";
import { SEND_USAGE, sendMain } from "./send.ts";
import { SEQUENCE_USAGE, sequenceMain, type SequenceContext } from "./sequence.ts";
import { POOLS_USAGE, poolsMain } from "./pools.ts";

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: CliFlags;
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
   numbers search               Search Telnyx inventory for available numbers
   numbers buy                  Purchase exact numbers (POST /number_orders)
   numbers owned                Numbers already owned on the Telnyx account
   phones list                  List agencyPhones from Twenty (or --source telnyx)
   phones sync                  Sync phone rows between Convex and Twenty
   conversation classify        Classify an inbound message against its thread
   conversation resolve         Classify, gate, and draft a styled reply
                                (prompts interactively when values are missing)
   login                        Sign in via the web app (PKCE browser flow)
   logout                       Remove the stored .blaster/ session
   whoami                       Show the stored session and verify it still works
   capabilities                 Every capability and the surface that implements it
   sequence validate|preview    Build and dry run a message sequence
   pools list|show|create|...   Manage number pools and assign one to a sequence
   pool                          Interactive: build a pool, pick numbers, assign it

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
  { id: "prospects.list", cli: "blaster prospects", mcp: "blaster_list_records", http: "" },
  { id: "numbers.search", cli: "blaster numbers search", mcp: "blaster_search_numbers", http: "GET /api/numbers/search" },
  { id: "numbers.purchase", cli: "blaster numbers buy", mcp: "blaster_purchase_number", http: "POST /api/numbers/purchase" },
  { id: "numbers.owned", cli: "blaster numbers owned", mcp: "blaster_list_numbers", http: "GET /api/numbers/owned" },
  { id: "phones.list", cli: "blaster phones list", mcp: "blaster_list_numbers", http: "GET /api/phones" },
  { id: "phones.sync", cli: "blaster phones sync", mcp: "blaster_sync_phones", http: "POST /api/phones/sync" },
  { id: "pools.list", cli: "blaster pools list", mcp: "blaster_list_pools", http: "GET /api/pools" },
  { id: "pools.new", cli: "blaster pool", mcp: "", http: "" },
  { id: "pools.get", cli: "blaster pools show", mcp: "blaster_get_pool", http: "GET /api/pools/:id" },
  { id: "pools.create", cli: "blaster pools create", mcp: "blaster_create_pool", http: "POST /api/pools" },
  { id: "pools.addNumber", cli: "blaster pools add-number", mcp: "blaster_add_pool_number", http: "POST /api/pools/:id/numbers" },
  { id: "pools.removeNumber", cli: "blaster pools remove-number", mcp: "blaster_remove_pool_number", http: "DELETE /api/pools/:id/numbers/:phoneNumber" },
  { id: "pools.reorder", cli: "blaster pools reorder", mcp: "blaster_reorder_pool", http: "PUT /api/pools/:id/numbers" },
  { id: "sequences.setPool", cli: "blaster pools assign", mcp: "blaster_set_sequence_pool", http: "POST /api/sequences/:id/pool" },
  { id: "conversations.list", cli: "blaster inbox list", mcp: "blaster_list_conversations", http: "GET /api/conversations" },
  { id: "conversations.read", cli: "blaster inbox show", mcp: "blaster_get_messages", http: "GET /api/conversations/:id/messages" },
  { id: "auth.login", cli: "blaster login", mcp: "", http: "" },
  { id: "auth.logout", cli: "blaster logout", mcp: "", http: "" },
  { id: "auth.whoami", cli: "blaster whoami", mcp: "", http: "" },
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
      if (positional.length > 0 && positional[0] === "help") {
        console.log(SEND_USAGE);
        return 0;
      }
      return await sendMain(positional, flags, json);
    }

    case "numbers": {
      const action = positional[0];
      if (action === "search") return await numbersSearch(flags, json);
      if (action === "buy" || action === "purchase") {
        return await numbersBuy(positional.slice(1), flags, json);
      }
      if (action === "owned" || action === "list") return await numbersOwned(json);
      console.error(`blaster numbers: unknown action "${action}"\n${NUMBERS_USAGE}`);
      return 1;
    }

    case "phones": {
      const action = positional[0];
      if (action === "list") return await phonesList(flags, json);
      if (action === "sync") return await phonesSync(flags, json);
      console.error(`blaster phones: unknown action "${action}"\n${PHONES_USAGE}`);
      return 1;
    }

    case "inbox": {
      const action = positional[0];
      if (action === "list") return await inboxList(flags, json);
      if (action === "show") return await inboxShow(positional.slice(1), flags, json);
      console.error(`blaster inbox: unknown action "${action}"\n${INBOX_USAGE}`);
      return 1;
    }

    case "conversation": {
      const action = positional[0];
      if (action === "classify") return await conversationClassify(positional.slice(1), flags, json);
      if (action === "resolve") return await conversationResolve(positional.slice(1), flags, json);
      console.error(`blaster conversation: unknown action "${action}"\n${CONVERSATION_USAGE}`);
      return 1;
    }

    case "login": {
      return await loginMain(flags, json);
    }

    case "logout": {
      if (positional.length > 0) {
        console.error(`blaster logout takes no positional arguments\n${LOGOUT_USAGE}`);
        return 1;
      }
      return await logoutMain(flags, json);
    }

    case "whoami": {
      if (positional.length > 0) {
        console.error(`blaster whoami takes no positional arguments\n${WHOAMI_USAGE}`);
        return 1;
      }
      return await whoamiMain(flags, json);
    }

    case "sequence": {
      const action = positional[0];
      if (action === "validate" || action === "check") return await sequenceValidate(flags, json);
      if (action === "preview") return await sequencePreview(flags, json);
      // Everything else is the recorded-draft lifecycle: new/list/show/edit/run/rm.
      const known = ["new", "create", "list", "ls", "show", "edit", "run", "dry-run", "rm", "delete"];
      if (action !== undefined && known.includes(action)) {
        return await sequenceMain(sequenceContext(flags, json), action, positional[1]);
      }
      if (action === "help") {
        console.log(SEQUENCE_USAGE);
        return 0;
      }
      // No action at all is handed to sequenceMain rather than answered here: it
      // opens the menu in a terminal, and sequenceMain is the one place that
      // decides between a prompt and the usage text.
      if (action === undefined) {
        return await sequenceMain(sequenceContext(flags, json), action, positional[1]);
      }
      console.error(`blaster sequence: unknown action "${action}"\n${SEQUENCE_USAGE}`);
      return 1;
    }

    case "pool":
    case "pools": {
      if (positional[0] === "help") {
        console.log(POOLS_USAGE);
        return 0;
      }
      return await poolsMain(positional.slice(1), flags, json);
    }

    default: {
      console.error(`blaster: unknown command "${command}"\n${USAGE}`);
      return 1;
    }
  }
}

/** Everything `blaster sequence` needs, injected so tests can drive it. */
function sequenceContext(
  flags: Map<string, string | boolean>,
  json: boolean,
): SequenceContext {
  return {
    root: process.cwd(),
    flags,
    json,
    jsonOut: asJson,
    now: () => Date.now(),
    // The machine hands over only the facts a send decision may depend on, so
    // they are forwarded as they are rather than widened with anything else.
    evaluate: (input) =>
      evaluateEligibility(process.env, DEFAULT_OPTIONS, { id: "dry-run", ...input }),
  };
}

/** Read stdin to the end, or return null when there is nothing piped in. */
async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : null;
}

/** A draft arrives on stdin or through --draft, so it can be piped or inlined. */
async function draftFrom(flags: Map<string, string | boolean>): Promise<SequenceDraft | null> {
  const inline = flags.get("draft");
  const source = typeof inline === "string" && inline.length > 0 ? inline : await readStdin();
  if (!source) {
    console.error("blaster sequence: pass a draft as JSON on stdin or with --draft");
    return null;
  }
  try {
    const parsed = JSON.parse(source) as Partial<SequenceDraft>;
    return {
      name: parsed.name ?? "",
      fromNumber: parsed.fromNumber ?? "",
      numberProfileId: parsed.numberProfileId,
      campaignId: parsed.campaignId,
      options: { ...DEFAULT_OPTIONS, ...parsed.options },
      steps: (parsed.steps ?? []).map((step) => ({
        text: step.text ?? "",
        delayHours: step.delayHours ?? 0,
        isStop: step.isStop ?? false,
      })),
    };
  } catch (error) {
    console.error(`blaster sequence: draft is not valid JSON: ${(error as Error).message}`);
    return null;
  }
}

async function sequenceValidate(flags: Map<string, string | boolean>, json: boolean): Promise<number> {
  const draft = await draftFrom(flags);
  if (!draft) return 1;
  const problems = validateDraft(draft);
  const summary = summarise(draft);
  if (json) {
    console.log(asJson({ valid: problems.length === 0, problems, summary }));
  } else if (problems.length === 0) {
    console.log(
      `Valid. ${summary.sendingSteps} sending step(s) across ${summary.spanHours}h` +
        `${summary.stopStep ? ", with a stop condition" : ""}.`,
    );
  } else {
    for (const problem of problems) console.error(`  ${problem.field}: ${problem.problem}`);
  }
  return problems.length === 0 ? 0 : 1;
}

async function sequencePreview(flags: Map<string, string | boolean>, json: boolean): Promise<number> {
  const draft = await draftFrom(flags);
  if (!draft) return 1;
  const recipients = (flags.get("recipients") as string | undefined) ?? "[]";
  let parsedRecipients: Recipient[];
  try {
    parsedRecipients = JSON.parse(recipients) as Recipient[];
  } catch (error) {
    console.error(`blaster sequence preview: --recipients is not valid JSON: ${(error as Error).message}`);
    return 1;
  }

  const rows = parsedRecipients.map((recipient) => {
    const verdict = evaluateEligibility(process.env, draft.options, recipient);
    return { id: recipient.id, ...verdict };
  });
  const ready = rows.filter((row) => row.eligible);
  const skipped = rows.filter((row) => !row.eligible);

  if (json) {
    console.log(asJson({ total: rows.length, ready: ready.length, skipped: skipped.length, rows }));
  } else {
    console.log(`${ready.length} of ${rows.length} recipient(s) would receive the next step.`);
    for (const row of rows) {
      const mark = row.eligible ? "send" : "skip";
      console.log(`  [${mark}] ${row.id.padEnd(24)} ${row.eligible ? row.profile?.profileId ?? "" : row.reason ?? ""}`);
    }
  }
  return 0;
}

const NUMBERS_USAGE = `Usage: blaster numbers <action>

  search --country <code> --type <local|toll_free|mobile|national|shared_cost>
         [--features sms,voice] [--limit <n>] [--locality <city>]
         [--contains <digits>] [--startsWith <digits>] [--endsWith <digits>]
      Search Telnyx inventory for available numbers.
  buy --number <E.164> [--number <E.164>] [--profile <id>] [--reference <ref>] [--no-sync]
      Purchase exact numbers. Upserts into Twenty agencyPhones unless --no-sync.
  owned
      Numbers already owned on the Telnyx account.`;

const PHONES_USAGE = `Usage: blaster phones <action>

  list [--source twenty|telnyx]
      List phone rows. Twenty agencyPhones by default, Telnyx account with --source telnyx.
  sync --direction <twenty-to-convex|convex-to-twenty> [--phones <json>]
      twenty-to-convex prints Twenty rows to store via the Convex importTwentyPhones
      mutation; convex-to-twenty upserts the given Convex rows into Twenty.`;

const CONVERSATION_USAGE = `Usage: blaster conversation <action>

  classify --message <text> [--history <json>]
      Classify one inbound message against its thread. Prints the message
      state, the conversation state, the resolution path, and whether the
      agent may reply. History is a JSON array of {role, text} turns.
  resolve --message <text> [--history <json>] [--text <draft>]
          [--to <number> --from <number>] [--send]
      Classify, apply the reply gate, and draft a styled reply. Missing values
      are prompted interactively; --send transmits the styled reply after a
      confirmation. A suppressed thread never prompts for a reply.`;

function telnyxKeyOrFail(): string | null {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) console.error("blaster failed (configuration): TELNYX_API_KEY not set");
  return apiKey ?? null;
}

function flagText(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

async function numbersSearch(flags: Map<string, string | boolean>, json: boolean): Promise<number> {
  const apiKey = telnyxKeyOrFail();
  if (!apiKey) return 1;
  const limitRaw = flagText(flags, "limit");
  const featuresRaw = flagText(flags, "features");
  const results = await searchAvailableNumbers(apiKey, {
    countryCode: flagText(flags, "country") ?? flagText(flags, "countryCode"),
    numberType: (flagText(flags, "type") ?? flagText(flags, "numberType") ?? undefined) as NumberType | undefined,
    features: featuresRaw ? (featuresRaw.split(",").map((f) => f.trim()).filter(Boolean) as NumberFeature[]) : undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
    locality: flagText(flags, "locality"),
    administrativeArea: flagText(flags, "administrativeArea"),
    contains: flagText(flags, "contains"),
    startsWith: flagText(flags, "startsWith"),
    endsWith: flagText(flags, "endsWith"),
  });
  if (json) {
    console.log(asJson({ count: results.length, numbers: results }));
  } else if (results.length === 0) {
    console.log("No available numbers matched.");
  } else {
    console.log(`${results.length} available number(s):`);
    for (const row of results) {
      console.log(`  ${row.phoneNumber}  ${(row.numberType ?? "").padEnd(10)} ${(row.features ?? []).join(",")}`);
    }
  }
  return 0;
}

async function numbersBuy(
  rest: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const apiKey = telnyxKeyOrFail();
  if (!apiKey) return 1;
  const inline = [flagText(flags, "number"), flagText(flags, "numbers")]
    .filter(Boolean)
    .flatMap((value) => (value as string).split(",").map((part) => part.trim()).filter(Boolean));
  const numbers = [...rest.filter((token) => !token.startsWith("--")), ...inline];
  let prompted = false;
  if (numbers.length === 0 && isInteractive(json)) {
    prompted = true;
    begin("blaster numbers buy");
    const answer = await askText("Numbers to purchase?", { placeholder: "+19705555098, +19705555099" });
    if (answer === null) return abort("no order was placed,");
    numbers.push(...answer.split(",").map((part) => part.trim()).filter(Boolean));
    if (numbers.length === 0) {
      console.error(`blaster numbers buy: at least one number is required\n${NUMBERS_USAGE}`);
      return 1;
    }
  }
  if (numbers.length === 0) {
    console.error(`blaster numbers buy: at least one number is required\n${NUMBERS_USAGE}`);
    return 1;
  }
  const order = await createNumberOrder(apiKey, {
    phoneNumbers: numbers,
    messagingProfileId: flagText(flags, "profile") ?? flagText(flags, "messagingProfileId"),
    customerReference: flagText(flags, "reference") ?? flagText(flags, "customerReference"),
  });
  let synced = 0;
  if (flags.get("no-sync") !== true && process.env.TWENTY_BASE_URL && process.env.TWENTY_API_KEY) {
    const client = new TwentyClient();
    for (const purchased of order.phoneNumbers) {
      await upsertAgencyPhone(client, {
        phoneNumber: purchased.phoneNumber,
        messagingProfileId: order.messagingProfileId,
        countryCode: purchased.countryCode,
        numberType: purchased.numberType,
        telnyxNumberId: purchased.id,
        orderId: order.id,
        status: purchased.status,
      });
      synced += 1;
    }
  }
  console.log(
    json
      ? asJson({ order, syncedToTwenty: synced })
      : `Order ${order.id ?? "unknown"} (${order.status ?? "unknown"}): ${order.phoneNumbers.length} number(s), ${synced} synced to Twenty.`,
  );
  if (prompted) finish(`Order ${order.id ?? "unknown"} placed.`);
  return 0;
}

async function numbersOwned(json: boolean): Promise<number> {
  const apiKey = telnyxKeyOrFail();
  if (!apiKey) return 1;
  const numbers = await listOwnedNumbers(apiKey);
  if (json) {
    console.log(asJson({ count: numbers.length, numbers }));
  } else if (numbers.length === 0) {
    console.log("No owned numbers.");
  } else {
    console.log(`${numbers.length} owned number(s):`);
    for (const row of numbers) {
      console.log(`  ${row.phoneNumber}  profile=${row.messagingProfileId ?? "none"}`);
    }
  }
  return 0;
}

async function phonesList(flags: Map<string, string | boolean>, json: boolean): Promise<number> {
  const source = flagText(flags, "source") ?? "twenty";
  if (source === "telnyx") return numbersOwned(json);
  const client = await twentyOrFail();
  const rows = await listAgencyPhones(client);
  const phones = rows.map(fromAgencyPhoneRecord);
  if (json) {
    console.log(asJson({ source, count: phones.length, phones }));
  } else if (phones.length === 0) {
    console.log("agencyPhones: no records.");
  } else {
    console.log(`agencyPhones: ${phones.length} record(s)`);
    for (const row of phones) {
      console.log(`  ${row.phoneNumber}  profile=${row.messagingProfileId ?? "none"}`);
    }
  }
  return 0;
}

async function phonesSync(flags: Map<string, string | boolean>, json: boolean): Promise<number> {
  const direction = flagText(flags, "direction") ?? "twenty-to-convex";
  const client = await twentyOrFail();
  const twentyPhones = (await listAgencyPhones(client)).map(fromAgencyPhoneRecord);
  if (direction === "twenty-to-convex") {
    console.log(
      json
        ? asJson({ direction, count: twentyPhones.length, phones: twentyPhones })
        : `${twentyPhones.length} Twenty phone(s). Store them via the Convex importTwentyPhones mutation.`,
    );
    return 0;
  }
  const raw = flagText(flags, "phones") ?? "[]";
  let convexPhones: Array<Record<string, string | null>>;
  try {
    convexPhones = JSON.parse(raw) as Array<Record<string, string | null>>;
  } catch {
    console.error("blaster phones sync: --phones is not valid JSON");
    return 1;
  }
  const plan = planPhoneSync(
    convexPhones.map((row) => ({
      phoneNumber: String(row.phoneNumber ?? row.phone_number ?? ""),
      messagingProfileId: (row.messagingProfileId ?? row.messaging_profile_id ?? null) as string | null,
      countryCode: (row.countryCode ?? row.country_code ?? null) as string | null,
      numberType: (row.numberType ?? row.number_type ?? null) as string | null,
      telnyxNumberId: (row.telnyxNumberId ?? row.telnyx_number_id ?? null) as string | null,
      orderId: (row.orderId ?? row.order_id ?? null) as string | null,
      status: (row.status ?? null) as string | null,
    })),
    twentyPhones,
  );
  let upserted = 0;
  for (const row of plan.toCreateInTwenty) {
    await upsertAgencyPhone(client, row);
    upserted += 1;
  }
  console.log(
    json
      ? asJson({ direction, ...plan, upserted })
      : `Sync: ${upserted} created in Twenty, ${plan.toStoreInConvex.length} to store in Convex.`,
  );
  return 0;
}

/** History turns arrive as JSON; ids and timestamps are filled in. */
function parseHistory(raw: string | undefined): ConversationMessage[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ id?: string; role?: string; text?: string; sentAt?: number }>;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((turn, index) => ({
      id: turn.id ?? `history-${index}`,
      role: turn.role === "agent" ? "agent" : "prospect",
      text: turn.text ?? "",
      sentAt: turn.sentAt ?? index,
    }));
  } catch {
    return null;
  }
}

async function conversationThread(
  rest: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<{ messages: ConversationMessage[] } | null> {
  let message = flagText(flags, "message") ?? rest[0];
  if (!message && isInteractive(json)) {
    begin("blaster conversation");
    message = (await askText("Inbound message to classify?")) ?? undefined;
    if (!message) {
      abort("nothing was classified,");
      return null;
    }
  }
  if (!message) {
    console.error(`blaster conversation: --message is required\n${CONVERSATION_USAGE}`);
    return null;
  }
  const history = parseHistory(flagText(flags, "history"));
  if (history === null) {
    console.error("blaster conversation: --history is not a JSON array of {role, text} turns");
    return null;
  }
  return {
    messages: [...history, { id: "inbound", role: "prospect", text: message, sentAt: Date.now() }],
  };
}

async function conversationClassify(
  rest: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const thread = await conversationThread(rest, flags, json);
  if (!thread) return 1;
  const result = classifyConversation(thread.messages);
  const confidence = latestConfidence(result.messages);
  const allowed = canAgentRespond(result.conversationState, result.resolution, confidence);
  if (json) {
    console.log(asJson({ ...result, confidence, allowed }));
  } else {
    const latest = result.messages.filter((m) => m.role === "prospect").pop();
    console.log(
      [
        `message:      ${latest?.state ?? "none"} (${confidence.toFixed(2)})`,
        `conversation: ${result.conversationState}`,
        `resolution:   ${result.resolution}`,
        `agent reply:  ${allowed ? "allowed" : "blocked"}`,
        `reason:       ${result.reason}`,
      ].join("\n"),
    );
  }
  return 0;
}

const RESOLUTION_OPTIONS: Array<{ value: ResolutionPath; label: string; hint?: string }> = [
  { value: "answer", label: "answer", hint: "Reply with a direct answer" },
  { value: "qualify", label: "qualify", hint: "Ask a qualifying question" },
  { value: "handle_objection", label: "handle_objection", hint: "Address their concern" },
  { value: "rebook", label: "rebook", hint: "Agree a later time" },
  { value: "escalate", label: "escalate", hint: "Hand to a human" },
  { value: "close", label: "close", hint: "Wrap up, high-stakes" },
];

async function conversationResolve(
  rest: string[],
  flags: Map<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const thread = await conversationThread(rest, flags, json);
  if (!thread) return 1;
  const interactive = isInteractive(json);
  const result = classifyConversation(thread.messages);
  const confidence = latestConfidence(result.messages);
  let resolution = result.resolution;
  let humanConfirmed = false;
  let allowed = canAgentRespond(result.conversationState, resolution, confidence);

  if (interactive) note("Classification", [
    `message: ${result.messages.filter((m) => m.role === "prospect").pop()?.state} (${confidence.toFixed(2)})`,
    `conversation: ${result.conversationState}`,
    `resolution: ${resolution}`,
    `agent reply: ${allowed ? "allowed" : "blocked"}`,
  ].join("\n"));

  if (resolution === "suppress") {
    // Compliance is not negotiable at a prompt: a suppressed thread never
    // asks the operator for reply text.
    if (json) {
      console.log(asJson({ ...result, confidence, allowed: false, styled: null, sent: null }));
    } else {
      console.log("Suppressed. This thread opted out, so no reply will be drafted or sent.");
    }
    return 0;
  }

  if (!allowed && interactive) {
    const override = await askSelect("The gate blocked a reply. Resolve it to a path?", RESOLUTION_OPTIONS);
    if (override === null) return abort("the thread keeps its classification,");
    resolution = override as ResolutionPath;
    if (resolution === "escalate") {
      if (json) console.log(asJson({ ...result, confidence, allowed: false, styled: null, sent: null }));
      else console.log("Escalated. Hand this thread to a human.");
      return 0;
    }
    if (resolution === "close") {
      const confirmed = await askConfirm("Closing is high-stakes. Confirm this resolution?");
      if (confirmed === null) return abort("the thread keeps its classification,");
      if (!confirmed) {
        console.log("Left unconfirmed. Re-run resolve to pick another path.");
        return 0;
      }
      humanConfirmed = true;
    }
    allowed = canAgentRespond(result.conversationState, resolution, confidence, humanConfirmed);
  }

  if (!allowed) {
    if (json) {
      console.log(asJson({ ...result, confidence, allowed: false, styled: null, sent: null }));
    } else {
      console.error(`Reply blocked: ${result.reason}`);
    }
    return 1;
  }

  let draft = flagText(flags, "text");
  if (!draft && interactive) {
    draft = (await askText("Reply draft? It will be styled to the texting voice.")) ?? undefined;
    if (!draft) return abort("no reply was drafted,");
  }
  if (!draft) {
    console.error(`blaster conversation resolve: --text is required when not prompting\n${CONVERSATION_USAGE}`);
    return 1;
  }
  const styled = formatAgentReply(draft);
  if (interactive) note("Styled reply", styled);

  let wantsSend = flags.get("send") === true;
  if (!wantsSend && interactive) {
    const confirmed = await askConfirm("Send this reply?");
    if (confirmed === null) return abort("the reply was drafted but not sent,");
    wantsSend = confirmed;
  }
  if (!wantsSend) {
    console.log(json ? asJson({ ...result, confidence, allowed, resolution, styled, sent: null }) : styled);
    if (interactive) finish("Drafted, not sent.");
    return 0;
  }

  let to = flagText(flags, "to");
  let from = flagText(flags, "from");
  if ((!to || !from) && interactive) {
    to = to ?? ((await askText("Recipient number?", { placeholder: "+353871234567" })) ?? undefined);
    from = from ?? ((await askText("Sending number?", { placeholder: "+353871234567" })) ?? undefined);
  }
  if (!to || !from) {
    console.error(`blaster conversation resolve: --to and --from are required to send\n${CONVERSATION_USAGE}`);
    return 1;
  }
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    console.error("blaster conversation resolve failed (configuration): TELNYX_API_KEY not set");
    return 1;
  }
  const profile = resolveMessagingProfile(process.env, { to });
  if (!profile.profileId) {
    console.error("blaster conversation resolve failed (configuration): no messaging profile is configured");
    return 1;
  }
  const sent = await sendMessage({ apiKey, from, to, text: styled, messagingProfileId: profile.profileId });
  console.log(
    json
      ? asJson({ ...result, confidence, allowed, resolution, styled, sent })
      : `Sent ${sent.id} (${sent.status}) from ${from} to ${to}.`,
  );
  if (interactive) finish(`Sent ${sent.id}.`);
  return 0;
}

function formatCapabilities(): string {  const width = Math.max(...CAPABILITIES.map((capability) => capability.id.length));
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
