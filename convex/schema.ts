import { defineSchema } from "convex/server";
import { messagingTables } from "./schema/messaging.js";
import { sequenceTables } from "./schema/sequences.js";
import { conversationTables } from "./schema/conversations.js";
import { phoneTables } from "./schema/phone.js";
import { discoveryTables } from "./schema/discovery.js";

/**
 * Blaster's own tables.
 *
 * Twenty remains the system of record for leads, calls, and prospects, so none
 * of that is mirrored here. What Blaster owns is the state Twenty cannot
 * represent: which messaging profile a jurisdiction is registered against,
 * which notifications have already been delivered, and the cost ceiling each
 * discovery run is allowed to spend.
 *
 * This file composes table definitions and defines none of its own. Each
 * domain's tables live in schema/<domain>.ts; see
 * docs/convex-naming-conventions.md (rule R6).
 */
export default defineSchema({
  ...messagingTables,
  ...sequenceTables,
  ...conversationTables,
  ...phoneTables,
  ...discoveryTables,
});
