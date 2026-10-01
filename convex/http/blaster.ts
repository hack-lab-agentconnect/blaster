import { httpAction } from "../_generated/server.js";
import type { HttpRouter } from "convex/server";
import manifest from "../../config/env-vars.json" with { type: "json" };
import { internal } from "../_generated/api.js";

/**
 * Deployment-inspection routes.
 *
 * Read-only by design: anything that writes provider state is a Convex
 * function, not a public route. These exist so a deployment can be inspected
 * without credentials, mirroring the same contract the Hono surface reads.
 *
 * HTTP actions cannot read `process.env`, so the status route asks a query.
 */
export function registerBlasterRoutes(http: HttpRouter): void {
  http.route({
    path: "/blaster/status",
    method: "GET",
    handler: httpAction(async (ctx) =>
      Response.json({
        service: "blaster",
        variables: manifest.vars.length,
        required: manifest.vars.filter((variable) => variable.required).length,
        environment: await ctx.runQuery(internal.blaster.queries.envStatus, {}),
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
}
