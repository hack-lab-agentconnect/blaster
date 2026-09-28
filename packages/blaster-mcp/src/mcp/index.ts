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
