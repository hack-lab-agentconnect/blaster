import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import manifest from "../config/env-vars.json" with { type: "json" };

/**
 * Blaster's read-only HTTP routes.
 *
 * Read-only by design: anything that writes provider state is a Convex
 * function, not a public route. These exist so a deployment can be inspected
 * without credentials, mirroring the same contract the Hono surface reads.
 *
 * HTTP actions cannot read `process.env`, so the status route asks a query.
 */
const http = httpRouter();

http.route({
  path: "/blaster/status",
  method: "GET",
  handler: httpAction(async (ctx) =>
    Response.json({
      service: "blaster",
      variables: manifest.vars.length,
      required: manifest.vars.filter((variable) => variable.required).length,
      environment: await ctx.runQuery(internal.blaster.envStatus, {}),
    }),
  ),
});

http.route({
  path: "/blaster/environment",
  method: "GET",
  handler: httpAction(async () => Response.json(manifest)),
});

http.route({
  path: "/blaster/capabilities",
  method: "GET",
  handler: httpAction(async () =>
    Response.json({
      capabilities: [
        { id: "pipeline.breakdown", title: "Pipeline breakdown", mutating: false },
        { id: "messaging.send", title: "Send one SMS", mutating: true },
        { id: "messaging.profiles", title: "List messaging profiles", mutating: false },
        { id: "webhooks.telnyx", title: "Inbound Telnyx events", mutating: true },
        { id: "conversations.list", title: "List SMS conversations", mutating: false },
        { id: "conversations.read", title: "Read one conversation's messages", mutating: false },
        { id: "discovery.run", title: "Discover prospects via treg", mutating: true },
      ],
    }),
  ),
});

export default http;
