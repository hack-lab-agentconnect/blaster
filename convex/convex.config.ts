import { defineApp } from "convex/server";
import agentmail from "@agentmail/convex";
import telnyx from "@listeningkit/telnyx/convex";
import treg from "@listeningkit/treg/convex";

/**
 * Blaster's Convex app.
 *
 * Two components are mounted:
 *   - treg, for prospect discovery and enrichment, with a per-call cost ceiling
 *     and a spend ledger so a runaway loop cannot bill without bound.
 *   - telnyx, which owns inbound webhook signature verification and messaging
 *     profile state.
 *
 * Both are components rather than hand-rolled clients so the provider state
 * lives in the database, survives a redeploy, and is queryable.
 */
const app = defineApp();

app.use(treg);
app.use(telnyx);
app.use(agentmail);

export default app;
