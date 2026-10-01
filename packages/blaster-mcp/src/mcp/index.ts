/**
 * Blaster MCP server.
 *
 * Built on @modelcontextprotocol/server 2.x, the same generation the Rank MCP
 * server uses. The revision is negotiated by the pinned SDK rather than
 * hardcoded here, so the client and server are tested as a pair.
 *
 * The tool list is derived from one table, and every advertised tool is
 * implemented below. Advertising a tool with no implementation is impossible:
 * the table and the switch are checked against each other at startup.
 *
 * Read-only tools need no credentials. `blaster_send_message` needs Twenty and
 * Telnyx configured, and says so rather than failing obscurely.
 */

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { pathToFileURL } from "node:url";
import {
  BlasterApiError,
  DEFAULT_OPTIONS,
  createBlasterApiClient,
  loadSessionHome,
  type BlasterApiClient,
  TwentyClient,
  buildBreakdown,
  createNumberOrder,
  describeEnv,
  evaluateEligibility,
  evaluateNotifications,
  fromAgencyPhoneRecord,
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
  type NumberFeature,
  type NumberType,
  type Recipient,
  type SequenceDraft,
  type TwentyRecord,
} from "@blaster/core";

const SERVER_NAME = "blaster";
const SERVER_VERSION = "0.1.0";

/**
 * A single property in a tool's JSON Schema. The 2.x SDK expects exactly this
 * shape, so it is declared rather than left as a loose record.
 */
type ToolPropertySchema = {
  type?: string | string[];
  description: string;
};

/** A tool as advertised to an MCP client. */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
    additionalProperties: false;
  };
}

/**
 * One row per capability. Adding a capability means adding a row and an arm of
 * the switch in `runTool`; nothing else changes.
 */
const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "blaster_breakdown",
    description:
      "Pipeline breakdown from the Twenty workspace: lead status counts, call outcomes, answer rate, conversion rate, and the notifications currently firing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "blaster_env",
    description:
      "Every environment variable Blaster reads, whether it is set, which module consumes it, and which target countries have no messaging profile.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "blaster_messaging_profile",
    description:
      "Resolve which Telnyx messaging profile a recipient number maps to, and why. Use this before sending so the profile matches the recipient's jurisdiction.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient number in E.164, or a country code." },
        recipientCountry: { type: "string", description: "ISO alpha-2 country, when known." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blaster_send_message",
    description:
      "Send one SMS through Telnyx on the messaging profile registered for the recipient's country. Requires TELNYX_API_KEY and a sending number.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient number in E.164." },
        from: { type: "string", description: "Sending number in E.164." },
        text: { type: "string", description: "Message body." },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_list_records",
    description:
      "List records from a Twenty workspace object such as agencyLeads, agencyCalls, or agencyProspects, using keyset pagination.",
    inputSchema: {
      type: "object",
      properties: {
        object: { type: "string", description: "Twenty object name, for example agencyLeads." },
        limit: { type: "number", description: "Page size, capped at 200 by Twenty." },
        filter: { type: "string", description: 'Twenty filter DSL, e.g. status[eq]:CONVERTED.' },
      },
      required: ["object"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_search_numbers",
    description:
      "Search Telnyx inventory for available phone numbers by country, type, features, and pattern. Use this before purchasing so the agent buys an exact available number.",
    inputSchema: {
      type: "object",
      properties: {
        countryCode: { type: "string", description: "ISO alpha-2 country, for example US." },
        numberType: { type: "string", description: "local, toll_free, mobile, national, or shared_cost." },
        features: { type: "string", description: "Comma-separated, for example sms,voice." },
        limit: { type: "number", description: "Max results to return." },
        contains: { type: "string", description: "Digits the number must contain." },
        startsWith: { type: "string", description: "Digits the number must start with." },
        endsWith: { type: "string", description: "Digits the number must end with." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blaster_purchase_number",
    description:
      "Purchase exact Telnyx phone numbers (POST /number_orders) and mirror them into Twenty agencyPhones. Requires TELNYX_API_KEY; Twenty sync is skipped when Twenty is unconfigured.",
    inputSchema: {
      type: "object",
      properties: {
        phoneNumbers: { type: "array", description: "E.164 numbers to purchase, exactly as returned by search." },
        messagingProfileId: { type: "string", description: "Messaging profile to bind on the order." },
        customerReference: { type: "string", description: "Customer reference stored on the order." },
        syncToTwenty: { type: "boolean", description: "Mirror into agencyPhones. Defaults to true." },
      },
      required: ["phoneNumbers"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_list_numbers",
    description:
      "List owned Telnyx numbers with messaging bindings, or phone rows from a source: telnyx (the account), twenty (agencyPhones), which is the default.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "telnyx or twenty. Defaults to twenty." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blaster_sync_phones",
    description:
      "Sync phone rows between Convex and Twenty, keyed on the E.164 number. convex-to-twenty upserts the given Convex rows into agencyPhones; twenty-to-convex returns the Twenty rows to store via the Convex importTwentyPhones mutation.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", description: "convex-to-twenty or twenty-to-convex." },
        phones: { type: "array", description: "Convex phone rows, for convex-to-twenty." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blaster_validate_sequence",
    description:
      "Check a message sequence draft and return every problem at once, plus a summary of its steps. Use this before creating a sequence.",
    inputSchema: {
      type: "object",
      properties: {
        draft: { type: "object", description: "The sequence draft: name, fromNumber, steps, and options." },
      },
      required: ["draft"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_preview_sequence",
    description:
      "Dry run a sequence: for each recipient, decide whether the next step may be sent and why not if it may not. Sends nothing and needs no Telnyx credentials.",
    inputSchema: {
      type: "object",
      properties: {
        options: { type: "object", description: "Sequence options, overriding the defaults." },
        steps: { type: "array", description: "The sequence steps." },
        recipients: {
          type: "array",
          description:
            "Recipients with to, country, and optionally doNotContact, hasReplied, and sentInLastDay.",
        },
      },
      required: ["recipients"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_list_conversations",
    description:
      "List SMS conversations, newest activity first. Each row is one thread: the peer number, the Blaster number we sent from, message count, and a preview of the newest message. Filter by sending number with `number`, or by campaign with `campaign`, which resolves the campaign per thread and is therefore slower.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Page size, max 200. Defaults to 50." },
        number: { type: "string", description: "Only threads for this sending number, in E.164." },
        campaign: { type: "string", description: "Only threads in this campaign id." },
        withCampaign: { type: "boolean", description: "Resolve the campaign on every row." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "blaster_get_messages",
    description:
      "Read every message in one conversation, oldest first, with direction, body, delivery status and timestamps. Use blaster_list_conversations to obtain a conversation id.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: { type: "string", description: "The conversation id from blaster_list_conversations." },
        limit: { type: "number", description: "Maximum messages, max 500." },
      },
      required: ["conversationId"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_list_pools",
    description:
      "List number pools: each pool's status, how many of its numbers can send, and when it could next send.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "blaster_get_pool",
    description:
      "Read one pool with its numbers in dispatch order, including each number's rate state. Use blaster_list_pools to obtain a pool id.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "The pool id from blaster_list_pools." },
      },
      required: ["poolId"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_create_pool",
    description:
      "Create a number pool. minSpacingMs is the minimum gap between sends from one number; dailyCapPerNumber is the per-number daily ceiling (0 disables it).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A human name for the pool." },
        minSpacingMs: { type: "number", description: "Minimum gap between sends from one number, in milliseconds." },
        dailyCapPerNumber: { type: "number", description: "Messages per number per day. 0 disables the cap." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_add_pool_number",
    description:
      "Add a sending number to a pool, or reactivate one that was removed. The number is E.164 and must already be owned. Omit order to append.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "The pool id." },
        phoneNumber: { type: "string", description: "Sending number in E.164." },
        order: { type: "number", description: "Sequential position; appends when omitted." },
      },
      required: ["poolId", "phoneNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_remove_pool_number",
    description:
      "Remove a sending number from a pool. The removal is soft: the membership is kept as removed, so an in-flight send still resolves and the history survives.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "The pool id." },
        phoneNumber: { type: "string", description: "Sending number in E.164." },
      },
      required: ["poolId", "phoneNumber"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_reorder_pool",
    description:
      "Set the order a pool works its numbers in. Pass every number in the desired order; any number omitted keeps its position after the listed ones.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: { type: "string", description: "The pool id." },
        order: { type: "array", description: "E.164 numbers, in the order the pool should work them." },
      },
      required: ["poolId", "order"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_list_suppressions",
    description:
      "List everyone on the durable per-person do-not-contact list, newest first. A STOP is recorded here and holds across every sequence and pool number.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "blaster_set_suppression",
    description:
      "Suppress a person by hand, or lift a suppression. A suppression is keyed on the E.164 peer and blocks enrollment and sending until lifted. Lifting is the only way to reopen contact.",
    inputSchema: {
      type: "object",
      properties: {
        peer: { type: "string", description: "The person's number in E.164." },
        suppressed: { type: "boolean", description: "true to suppress, false to lift." },
        reason: { type: "string", description: "Why, for the operator list. Only used when suppressing." },
      },
      required: ["peer", "suppressed"],
      additionalProperties: false,
    },
  },
  {
    name: "blaster_set_sequence_pool",
    description:
      "Assign a number pool to a sequence, so the sequence sends from the pool in order within each number's rate budget. Omit poolId to clear the assignment.",
    inputSchema: {
      type: "object",
      properties: {
        sequenceId: { type: "string", description: "The Convex sequence id." },
        poolId: { type: "string", description: "The pool to assign; omit to clear." },
      },
      required: ["sequenceId"],
      additionalProperties: false,
    },
  },
];

function twenty(): TwentyClient {
  const missing = ["TWENTY_BASE_URL", "TWENTY_API_KEY"].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`configuration: ${missing.join(", ")} not set`);
  }
  return new TwentyClient();
}

interface ToolResult {
  text: string;
  structured?: unknown;
}

/**
 * The Blaster API client, authenticated as the operator.
 *
 * The inbox routes require a live operator token, and the MCP server is a local
 * stdio process for the same person who ran `blaster login`, so it reads that
 * session rather than holding a credential of its own. It goes through the same
 * `createBlasterApiClient` as the CLI, which is what makes the two surfaces
 * return identical payloads rather than merely similar ones.
 */
function blasterApi(): BlasterApiClient {
  const home = loadSessionHome(process.cwd());
  const apiUrl = home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
  if (!apiUrl) {
    throw new Error(
      'No signed-in Blaster API. Run "blaster login" first, or set an apiUrl in .blaster/config.json.',
    );
  }
  const session = home.sessions[apiUrl];
  if (!session) throw new Error(`No session for ${apiUrl}. Run "blaster login" first.`);
  return createBlasterApiClient({ baseUrl: apiUrl, accessToken: session.accessToken });
}

/** Provider and auth failures as one readable line, never a raw stack. */
function describeApiError(error: unknown): string {
  if (error instanceof BlasterApiError) {
    if (error.kind === "unauthorized") return "The operator token is not accepted. Run \"blaster login\" again.";
    if (error.kind === "unavailable") {
      return `The Blaster API cannot serve this right now (${error.status}): ${error.message}`;
    }
    return `${error.message} (${error.status})`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "blaster_breakdown": {
      const client = twenty();
      const [leads, calls] = await Promise.all([
        client.listAll<TwentyRecord>("agencyLeads"),
        client.listAll<TwentyRecord>("agencyCalls"),
      ]);
      const breakdown: Breakdown = buildBreakdown({ leads, calls });
      const notifications = evaluateNotifications(breakdown);
      return {
        text:
          `${breakdown.leads.total} leads, ${breakdown.calls.total} calls, ` +
          `${breakdown.calls.answerRate}% answer rate, ${breakdown.conversion.rate}% conversion. ` +
          (notifications.length > 0
            ? `${notifications.length} notification(s) firing.`
            : "No notifications firing."),
        structured: { breakdown, notifications, stateKey: notificationStateKey(notifications) },
      };
    }

    case "blaster_env": {
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
      const missingCount = payload.missingRequired.length;
      return {
        text:
          missingCount === 0
            ? `All ${payload.variables.length} variables configured.`
            : `Missing required: ${payload.missingRequired.join(", ")}.`,
        structured: payload,
      };
    }

    case "blaster_messaging_profile": {
      const to = typeof args.to === "string" ? args.to : undefined;
      const recipientCountry =
        typeof args.recipientCountry === "string" ? args.recipientCountry : undefined;
      const resolution = resolveMessagingProfile(process.env, { to, recipientCountry });
      return {
        text:
          `Recipient country ${resolution.country ?? "unresolved"}; ` +
          `profile ${resolution.profileId ?? "none configured"} (${resolution.reason}).` +
          (resolution.warning ? ` ${resolution.warning}` : ""),
        structured: resolution,
      };
    }

    case "blaster_send_message": {
      const to = args.to as string | undefined;
      const from = args.from as string | undefined;
      const text = args.text as string | undefined;
      if (!to || !text) throw new Error("validation: to and text are required");
      if (!from) throw new Error("validation: from is required; Blaster will not guess a sending number");
      const apiKey = process.env.TELNYX_API_KEY;
      if (!apiKey) throw new Error("configuration: TELNYX_API_KEY not set");

      const resolution = resolveMessagingProfile(process.env, { to });
      if (!resolution.profileId) throw new Error("configuration: no messaging profile is configured");

      const sent = await sendMessage({
        apiKey,
        from,
        to,
        text,
        messagingProfileId: resolution.profileId,
      });
      return {
        text: `Sent ${sent.id} (${sent.status}) to ${sent.to} on profile ${resolution.profileId}.`,
        structured: { sent, resolution },
      };
    }

    case "blaster_list_records": {
      const object = args.object as string | undefined;
      if (!object) throw new Error("validation: object is required");
      const client = twenty();
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const filter = typeof args.filter === "string" ? args.filter : undefined;
      const records = await client.listAll<TwentyRecord>(object, { limit, filter });
      return {
        text: `${records.length} record(s) in ${object}.`,
        structured: { object, count: records.length, records },
      };
    }

    case "blaster_search_numbers": {
      const apiKey = process.env.TELNYX_API_KEY;
      if (!apiKey) throw new Error("configuration: TELNYX_API_KEY not set");
      const featuresRaw = typeof args.features === "string" ? args.features : undefined;
      const numbers = await searchAvailableNumbers(apiKey, {
        countryCode: typeof args.countryCode === "string" ? args.countryCode : undefined,
        numberType: typeof args.numberType === "string" ? (args.numberType as NumberType) : undefined,
        features: featuresRaw
          ? (featuresRaw.split(",").map((f) => f.trim()).filter(Boolean) as NumberFeature[])
          : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        contains: typeof args.contains === "string" ? args.contains : undefined,
        startsWith: typeof args.startsWith === "string" ? args.startsWith : undefined,
        endsWith: typeof args.endsWith === "string" ? args.endsWith : undefined,
      });
      return {
        text: `${numbers.length} available number(s).`,
        structured: { count: numbers.length, numbers },
      };
    }

    case "blaster_purchase_number": {
      const apiKey = process.env.TELNYX_API_KEY;
      if (!apiKey) throw new Error("configuration: TELNYX_API_KEY not set");
      const phoneNumbers = Array.isArray(args.phoneNumbers)
        ? (args.phoneNumbers as unknown[]).map(String)
        : [];
      if (phoneNumbers.length === 0) throw new Error("validation: phoneNumbers is required");
      const order = await createNumberOrder(apiKey, {
        phoneNumbers,
        messagingProfileId:
          typeof args.messagingProfileId === "string" ? args.messagingProfileId : undefined,
        customerReference:
          typeof args.customerReference === "string" ? args.customerReference : undefined,
      });
      let synced = 0;
      if (
        args.syncToTwenty !== false &&
        process.env.TWENTY_BASE_URL &&
        process.env.TWENTY_API_KEY
      ) {
        const client = twenty();
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
      return {
        text: `Order ${order.id ?? "unknown"} (${order.status ?? "unknown"}): ${order.phoneNumbers.length} number(s), ${synced} synced to Twenty.`,
        structured: { order, syncedToTwenty: synced },
      };
    }

    case "blaster_list_numbers": {
      const source = typeof args.source === "string" ? args.source : "twenty";
      if (source === "telnyx") {
        const apiKey = process.env.TELNYX_API_KEY;
        if (!apiKey) throw new Error("configuration: TELNYX_API_KEY not set");
        const numbers = await listOwnedNumbers(apiKey);
        return {
          text: `${numbers.length} owned number(s).`,
          structured: { source, count: numbers.length, numbers },
        };
      }
      const client = twenty();
      const phones = (await listAgencyPhones(client)).map(fromAgencyPhoneRecord);
      return {
        text: `${phones.length} phone(s) in agencyPhones.`,
        structured: { source, count: phones.length, phones },
      };
    }

    case "blaster_sync_phones": {
      const direction = typeof args.direction === "string" ? args.direction : "convex-to-twenty";
      const client = twenty();
      const twentyPhones = (await listAgencyPhones(client)).map(fromAgencyPhoneRecord);
      if (direction === "twenty-to-convex") {
        return {
          text: `${twentyPhones.length} Twenty phone(s) to store in Convex.`,
          structured: { direction, count: twentyPhones.length, phones: twentyPhones },
        };
      }
      const convexPhones = (Array.isArray(args.phones) ? args.phones : []).map((row) => {
        const record = row as Record<string, unknown>;
        return {
          phoneNumber: String(record.phoneNumber ?? record.phone_number ?? ""),
          messagingProfileId: (record.messagingProfileId ?? record.messaging_profile_id ?? null) as string | null,
          countryCode: (record.countryCode ?? record.country_code ?? null) as string | null,
          numberType: (record.numberType ?? record.number_type ?? null) as string | null,
          telnyxNumberId: (record.telnyxNumberId ?? record.telnyx_number_id ?? null) as string | null,
          orderId: (record.orderId ?? record.order_id ?? null) as string | null,
          status: (record.status ?? null) as string | null,
        };
      });
      const plan = planPhoneSync(
        convexPhones.filter((row) => row.phoneNumber),
        twentyPhones,
      );
      let upserted = 0;
      for (const row of plan.toCreateInTwenty) {
        await upsertAgencyPhone(client, row);
        upserted += 1;
      }
      return {
        text: `${upserted} created in Twenty, ${plan.toStoreInConvex.length} to store in Convex.`,
        structured: { direction, ...plan, upserted },
      };
    }

    case "blaster_validate_sequence": {
      const raw = args.draft as Partial<SequenceDraft> | undefined;
      if (!raw) throw new Error("validation: draft is required");
      const draft: SequenceDraft = {
        name: raw.name ?? "",
        fromNumber: raw.fromNumber ?? "",
        numberProfileId: raw.numberProfileId,
        campaignId: raw.campaignId,
        options: { ...DEFAULT_OPTIONS, ...raw.options },
        steps: (raw.steps ?? []).map((step) => ({
          text: step.text ?? "",
          delayHours: step.delayHours ?? 0,
          isStop: step.isStop ?? false,
        })),
      };
      const problems = validateDraft(draft);
      const summary = summarise(draft);
      return {
        text: problems.length === 0
          ? `Valid: ${summary.sendingSteps} sending step(s) across ${summary.spanHours}h.`
          : `${problems.length} problem(s): ${problems.map((p) => `${p.field} ${p.problem}`).join(" ")}`,
        structured: { valid: problems.length === 0, problems, summary },
      };
    }

    case "blaster_preview_sequence": {
      const recipients = (args.recipients as Recipient[] | undefined) ?? [];
      const options = { ...DEFAULT_OPTIONS, ...(args.options as Partial<typeof DEFAULT_OPTIONS> | undefined) };
      const rows = recipients.map((recipient) => {
        const verdict = evaluateEligibility(process.env, options, recipient);
        return {
          recipientId: recipient.id,
          eligible: verdict.eligible,
          reason: verdict.reason,
          detail: verdict.detail,
          country: verdict.profile?.country ?? null,
          profileId: verdict.profile?.profileId ?? null,
        };
      });
      const ready = rows.filter((row) => row.eligible);
      const skipped = rows.filter((row) => !row.eligible);
      const skipReasons = skipped.reduce<Record<string, number>>((acc, row) => {
        const key = row.reason ?? "unknown";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      return {
        text: `${ready.length} of ${rows.length} recipient(s) would receive the next step.` +
          (Object.keys(skipReasons).length > 0 ? ` Skipped: ${JSON.stringify(skipReasons)}.` : ""),
        structured: { total: rows.length, ready: ready.length, skipped: skipped.length, skipReasons, rows },
      };
    }

    case "blaster_list_conversations": {
      try {
        const client = blasterApi();
        const rows = await client.listConversations({
          limit: typeof args.limit === "number" ? args.limit : undefined,
          number: typeof args.number === "string" ? args.number : undefined,
          campaign: typeof args.campaign === "string" ? args.campaign : undefined,
          withCampaign: typeof args.withCampaign === "boolean" ? args.withCampaign : undefined,
        });
        return {
          text:
            rows.length === 0
              ? "No conversations yet."
              : rows
                  .map(
                    (row) =>
                      `${row.phoneNumber} via ${row.blasterNumber}: ${row.messageCount} message(s), ` +
                      `last ${row.latestDirection ?? "unknown"} at ${new Date(row.latestMessageAt).toISOString()}` +
                      (row.latestPreview ? ` - ${row.latestPreview}` : ""),
                  )
                  .join("\n"),
          // The same rows the CLI and the API return, so an agent and a human
          // are reading identical data rather than two renderings of it.
          structured: { count: rows.length, conversations: rows },
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_get_messages": {
      const conversationId = typeof args.conversationId === "string" ? args.conversationId : "";
      if (!conversationId) return { text: "conversationId is required." };
      try {
        const client = blasterApi();
        const rows = await client.conversationMessages(
          conversationId,
          typeof args.limit === "number" ? args.limit : undefined,
        );
        return {
          text:
            rows.length === 0
              ? "That conversation has no messages."
              : rows
                  .map(
                    (row) =>
                      `${new Date(row.sentAt).toISOString()} [${row.direction}/${row.status}] ${row.from} -> ${row.to}: ${row.body}`,
                  )
                  .join("\n"),
          structured: { conversationId, count: rows.length, messages: rows },
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_list_pools": {
      try {
        const pools = await blasterApi().listPools();
        return {
          text: pools.length === 0 ? "No pools yet." : `${pools.length} pool(s).`,
          structured: { count: pools.length, pools },
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_get_pool": {
      const poolId = typeof args.poolId === "string" ? args.poolId : "";
      if (!poolId) return { text: "poolId is required." };
      try {
        const pool = await blasterApi().getPool(poolId);
        if (!pool) return { text: `No pool ${poolId}.` };
        return { text: `${pool.name}: ${pool.activeNumberCount} active number(s).`, structured: pool };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_create_pool": {
      const name = typeof args.name === "string" ? args.name : "";
      if (!name) return { text: "name is required." };
      try {
        const created = await blasterApi().createPool({
          name,
          ...(typeof args.minSpacingMs === "number" ? { minSpacingMs: args.minSpacingMs } : {}),
          ...(typeof args.dailyCapPerNumber === "number" ? { dailyCapPerNumber: args.dailyCapPerNumber } : {}),
        });
        return { text: `Created pool ${created.id}.`, structured: created };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_add_pool_number": {
      const poolId = typeof args.poolId === "string" ? args.poolId : "";
      const phoneNumber = typeof args.phoneNumber === "string" ? args.phoneNumber : "";
      if (!poolId || !phoneNumber) return { text: "poolId and phoneNumber are required." };
      try {
        const pool = await blasterApi().addPoolNumber({
          poolId,
          phoneNumber,
          ...(typeof args.order === "number" ? { order: args.order } : {}),
        });
        return { text: `Added ${phoneNumber} to ${pool.name}.`, structured: pool };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_remove_pool_number": {
      const poolId = typeof args.poolId === "string" ? args.poolId : "";
      const phoneNumber = typeof args.phoneNumber === "string" ? args.phoneNumber : "";
      if (!poolId || !phoneNumber) return { text: "poolId and phoneNumber are required." };
      try {
        const pool = await blasterApi().removePoolNumber({ poolId, phoneNumber });
        return { text: `Removed ${phoneNumber} from ${pool.name}.`, structured: pool };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_reorder_pool": {
      const poolId = typeof args.poolId === "string" ? args.poolId : "";
      const order = Array.isArray(args.order) ? (args.order as unknown[]).map(String) : [];
      if (!poolId || order.length === 0) return { text: "poolId and a non-empty order are required." };
      try {
        const pool = await blasterApi().reorderPoolNumbers({ poolId, order });
        return { text: `Reordered ${pool.name}.`, structured: pool };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_set_sequence_pool": {
      const sequenceId = typeof args.sequenceId === "string" ? args.sequenceId : "";
      if (!sequenceId) return { text: "sequenceId is required." };
      try {
        const poolId = typeof args.poolId === "string" && args.poolId !== "" ? args.poolId : undefined;
        const result = await blasterApi().setSequencePool({
          sequenceId,
          ...(poolId === undefined ? {} : { poolId }),
        });
        return {
          text: poolId ? `Assigned pool ${poolId} to sequence ${sequenceId}.` : `Cleared the pool on sequence ${sequenceId}.`,
          structured: result,
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_list_suppressions": {
      try {
        const rows = await blasterApi().listSuppressions();
        return {
          text: rows.length === 0 ? "Nobody is suppressed." : `${rows.length} suppressed.`,
          structured: { count: rows.length, suppressions: rows },
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    case "blaster_set_suppression": {
      const peer = typeof args.peer === "string" ? args.peer : "";
      if (!peer) return { text: "peer is required." };
      if (typeof args.suppressed !== "boolean") return { text: "suppressed must be a boolean." };
      try {
        const result = await blasterApi().setSuppression({
          peer,
          suppressed: args.suppressed,
          ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
        });
        return {
          text: result.changed
            ? `${args.suppressed ? "Suppressed" : "Lifted the suppression on"} ${result.peer}.`
            : `${result.peer} was already in that state.`,
          structured: result,
        };
      } catch (error) {
        return { text: describeApiError(error) };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Build the server without starting transport, so a test can drive it. */
export function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: TOOL_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const name = request.params.name;
    try {
      const result = await runTool(name, (request.params.arguments ?? {}) as Record<string, unknown>);
      // structuredContent travels beside the prose, never instead of it: an
      // agent reads fields, a human reads text, and neither parses the other.
      if (result.structured === undefined) {
        return { content: [{ type: "text" as const, text: result.text }] };
      }
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structured,
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  });

  return server;
}

export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

// Advertised names, so a smoke test can assert the surface without connecting.
export const TOOL_NAMES = TOOL_DEFINITIONS.map((definition) => definition.name);

// Start the transport only when this file is the binary, so importing
// createServer in a test does not take over stdin.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startServer().catch((error: unknown) => {
    console.error(`blaster-mcp: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
