/**
 * Blaster HTTP surface.
 *
 * Hono owns the request surface; Convex owns the backend, the treg component,
 * and the telnyx component. Anything that mutates provider state is a Convex
 * action rather than a route here, so the two never disagree about who owns
 * a write.
 *
 * Routes are registered inline and each one resolves its own dependencies.
 * There is no global middleware that can decide things a route should decide
 * for itself, which keeps a partially configured deployment answering health
 * and env questions even when the providers are unset.
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  DEFAULT_OPTIONS,
  TwentyClient,
  createNumberOrder,
  decodeJwtPayload,
  describeEnv,
  evaluateEligibility,
  filtersToDsl,
  findAgencyPhoneRow,
  fromAgencyPhoneRecord,
  listAgencyPhones,
  listOwnedNumbers,
  markProspectOutbound,
  missingRequired,
  normaliseCountry,
  planPhoneSync,
  profileBoundToNumber,
  prospectFields,
  resolveMemberIdentity,
  resolveMessagingProfile,
  searchAvailableNumbers,
  searchProspectsPage,
  splitEligibility,
  stepText,
  summarise,
  uncoveredCountries,
  upsertAgencyPhone,
  validateDraft,
  validateProspectFilters,
  walkProspectRows,
  type NumberFeature,
  type NumberType,
  type Recipient,
  type SequenceDraft,
  type SequenceStepDraft,
  type TwentyAccessTokenClaims,
} from "@blaster/core";
import { TelnyxError, listMessagingProfiles, sendMessage } from "./lib/telnyx/messaging/index.ts";
import { readBreakdownFrom, twentyReader } from "./lib/pipeline/breakdown/index.ts";
import { applyOutboundStatus, conversationMessages, listConversations, recordInboundMessage } from "./lib/convex/index.ts";
import {
  addPoolNumber,
  createPool,
  getPool,
  listLedgerNumbers,
  listPools,
  listSequences,
  removePoolNumber,
  reorderPoolNumbers,
  setSequencePool,
} from "./lib/convex/index.ts";
import { requireOperator, resolveOperatorActor } from "./lib/auth/operator/index.ts";
import { broadcastReply, classifyMessageRules } from "@blaster/core";
import {
  eventTypeOf,
  handleCallEvent,
  isCallEvent,
  isInboundEvent,
  messageIdOf,
  readInboundMessage,
  readOutboundStatus,
  resolveOwnedDestination,
  statusOfOutboundEvent,
  verifyTelnyxWebhook,
  type CallRecordingPayload,
  type OwnershipSources,
  type TelnyxWebhookEvent,
} from "@blaster/core";
import {
  checkOperatorToken,
  exchangeAuthorizationCode,
  loadOAuthConfig,
  oauthEndpoints,
  refreshOperatorToken,
} from "./lib/twenty/oauth/index.ts";

const app = new Hono();

/** Errors are narrowed so a provider body never reaches the client verbatim. */
function fail(
  c: Context,
  error: unknown,
  fallback: string,
  status: ContentfulStatusCode = 500,
) {
  if (error instanceof TelnyxError) {
    return c.json({ error: fallback, detail: error.message }, status >= 500 ? 502 : status);
  }
  // Both Twenty transports carry a `status`, but they are different classes:
  // `TwentyError` from the REST client, `TwentyOAuthError` from the OAuth
  // provider. Matching only the first meant every OAuth failure fell through to
  // the bare 500 below, so a 401 from the auth-guard and a 400 from a rejected
  // authorization code were indistinguishable and both said nothing at all.
  // A failure whose cause cannot be seen is one nobody can diagnose, so the
  // detail is carried through for both.
  if (error instanceof Error && (error.name === "TwentyError" || error.name === "TwentyOAuthError")) {
    const twentyStatus = (error as { status?: number }).status ?? status;
    return c.json(
      { error: fallback, detail: error.message },
      twentyStatus >= 500 ? 502 : (twentyStatus as ContentfulStatusCode),
    );
  }
  return c.json({ error: fallback }, status);
}

function twentyClient(): TwentyClient {
  return new TwentyClient();
}

/**
 * Push a reply to the members who have a Bark key.
 *
 * Awaited but never allowed to fail the request: the message is already stored
 * and the sequence already stopped, and Telnyx retries a 500 three times, so a
 * notification outage would otherwise turn a stored reply into a repeated one.
 * A Twenty that cannot be reached is the same case, and is handled inside
 * `broadcastReply` rather than here.
 */
async function notifyReply(
  inbound: { to: string; body: string },
  stopped: Array<{ ownerMemberId: string | null }>,
): Promise<void> {
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) return;
  try {
    // Owners come from the stopped records themselves: the routing lives in
    // the enrollment, not in a list kept beside the workflow. Absent owners
    // fall back to every member with a key, inside broadcastReply.
    const targetMemberIds = stopped
      .map((row) => row.ownerMemberId)
      .filter((id): id is string => typeof id === "string" && id !== "");
    await broadcastReply(twentyClient(), {
      peer: inbound.to,
      preview: inbound.body.slice(0, NOTIFY_PREVIEW_LENGTH),
      stoppedCount: stopped.length,
      ...(targetMemberIds.length > 0 ? { targetMemberIds } : {}),
    });
  } catch {
    // `broadcastReply` reports rather than throws; this is belt and braces for
    // the case where something in the fan-out itself is wrong.
  }
}

/**
 * The access token's claims, or null when it is not a JWT.
 *
 * Introspection has already proved the token live by the time this is used, and
 * it is the trust boundary: Twenty publishes no JWKS, so there is nothing to
 * verify the signature against even if we wanted to. See `decodeJwtPayload`.
 */
function claimsOfToken(token: string): TwentyAccessTokenClaims | null {
  try {
    return decodeJwtPayload<TwentyAccessTokenClaims>(token);
  } catch {
    return null;
  }
}

/**
 * The `agencyPhones` records, or nothing when Twenty is not configured.
 *
 * A send must not fail because the profile lookup could not run, so this
 * returns an empty list rather than throwing: the country rules and the global
 * variable still apply, and the reason the bound profile was unavailable is
 * visible in the response's `resolution`.
 */
async function agencyPhonesForSending(): Promise<
  Array<{ phoneNumber?: string | null; messagingProfileId?: string | null }>
> {
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) return [];
  try {
    const rows = await listAgencyPhones(twentyClient());
    return rows.map(fromAgencyPhoneRecord);
  } catch {
    return [];
  }
}

app.get("/health", (c) =>
  c.json({
    service: "blaster",
    status: "ok",
    missingRequired: missingRequired(),
  }),
);

/**
 * Conversation inbox, the read half of what the terminal client will read.
 *
 * Gated on a live operator token because these rows carry prospect phone
 * numbers and message bodies, and the Convex functions behind them are public.
 *
 * The gate is attached per route rather than with `inbox.use("/*", ...)`. A
 * blanket middleware on a sub-app mounted at `/api` also catches every route
 * that already existed, which would put the webhook and the phone views behind
 * an operator token they never asked for. Per-route means a route added later
 * is ungated by default, which is the safer direction to fail: `check:surfaces`
 * is where a new inbox route is supposed to be declared.
 */
const inbox = new Hono();

inbox.get("/conversations", requireOperator, async (c) => {
  const limit = Number(c.req.query("limit") ?? "") || undefined;
  const result = await listConversations({
    ...(limit ? { limit } : {}),
    ...(c.req.query("number") ? { number: c.req.query("number") as string } : {}),
    ...(c.req.query("campaign") ? { campaign: c.req.query("campaign") as string } : {}),
    // The campaign costs a lookup per row, so it is only resolved when asked
    // for rather than on every list.
    withCampaign: c.req.query("campaign") !== undefined || c.req.query("withCampaign") === "true",
  });
  if (result.status === "not-configured") {
    return c.json({ error: "CONVEX_URL is not configured" }, 503);
  }
  if (result.status === "failed") {
    return c.json({ error: "Failed to read conversations", detail: result.error }, 502);
  }
  return c.json({ count: result.rows.length, conversations: result.rows });
});

/**
 * Convex document ids are lowercase alphanumeric with a fixed length that has
 * changed between releases, so this checks the shape and not an exact width.
 * The bound exists to reject obvious garbage like `not-an-id` before a round
 * trip, not to be the authority on validity: Convex still validates, and its
 * argument error is what turns a stale-but-well-formed id into a 404.
 *
 * The point is that this must never be inferred from a free-text error. An
 * earlier version matched on the word "convex" and reported every backend
 * outage as a missing conversation, which is the one answer an operator must
 * never be given wrongly.
 */
const CONVEX_ID = /^[a-z0-9]{16,64}$/;

inbox.get("/conversations/:id/messages", requireOperator, async (c) => {
  const id = c.req.param("id");
  if (!CONVEX_ID.test(id)) {
    return c.json({ error: "Unknown conversation" }, 404);
  }
  const limit = Number(c.req.query("limit") ?? "") || undefined;
  const result = await conversationMessages(id, limit);
  if (result.status === "not-configured") {
    return c.json({ error: "CONVEX_URL is not configured" }, 503);
  }
  if (result.status === "failed") {
    // Argument validation is the only failure that means "you asked for
    // something wrong"; everything else is ours.
    const clientMistake = /argument|invalid/i.test(result.error);
    return c.json(
      { error: clientMistake ? "Unknown conversation" : "Failed to read messages", detail: result.error },
      clientMistake ? 404 : 502,
    );
  }
  return c.json({ count: result.rows.length, messages: result.rows });
});

/**
 * Workspace sending numbers the operator may send from.
 *
 * Authenticated: these rows carry provisioned numbers and their profile
 * bindings. This is the selector the guided send consumes: the client picks
 * an `agencyPhoneId` and every later call re-resolves that id to the row, so
 * a surface can never smuggle a number or a profile past the workspace.
 *
 * Only rows that can actually send are listed. A number with no
 * messagingProfileId is rejected at send time with a 409, and a row whose
 * status is `available` is an unpurchased candidate, so neither is offered.
 * An unconfigured Twenty reads as an empty list, the same direction
 * `agencyPhonesForSending` fails in, rather than a 500.
 *
 * Boundary note: requireOperator proves a live operator token, but the
 * Twenty read below uses the deployment's TWENTY_BASE_URL + TWENTY_API_KEY
 * and does not map the operator to a tenant workspace. Do not claim
 * multi-tenant isolation for this list until that mapping exists.
 *
 * Deliberately not `/api/numbers/owned`: that route is the unauthenticated
 * Telnyx-account inventory, a different contract that must keep meaning it.
 */
inbox.get("/agency-phones", requireOperator, async (c) => {
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) {
    return c.json({ count: 0, phones: [] });
  }
  try {
    const rows = await listAgencyPhones(twentyClient());
    const phones = [];
    for (const record of rows) {
      const parsed = fromAgencyPhoneRecord(record);
      if (!parsed.phoneNumber || !parsed.messagingProfileId) continue;
      if ((parsed.status ?? "").toLowerCase() === "available") continue;
      phones.push({
        agencyPhoneId: record.id,
        phoneNumber: parsed.phoneNumber,
        label: parsed.countryCode ? `${parsed.phoneNumber} (${parsed.countryCode})` : parsed.phoneNumber,
        countryCode: parsed.countryCode ?? null,
      });
    }
    return c.json({ count: phones.length, phones });
  } catch (error) {
    return fail(c, error, "Failed to list sending numbers", 502);
  }
});

/**
 * Prospect filter menu, exactly as the guided send renders it.
 *
 * The menu is grounded in the vendored generated Twenty schema
 * (`AgencyProspectFilterInput`): names are field API names and operators are
 * the REST-valid subset of each GraphQL filter kind. No Twenty call is
 * needed, so this answers even when Twenty is unconfigured.
 */
inbox.get("/prospects/fields", requireOperator, (c) => {
  return c.json({ fields: prospectFields() });
});

/** A batch larger than this is refused rather than started: a runaway filter
 *  must fail at the gate, not after three hundred sends. */
const MAX_BATCH_PROSPECTS = 500;

inbox.post("/prospects/search", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    filters?: unknown;
    cursor?: unknown;
    limit?: unknown;
  } | null;
  if (!body) return c.json({ error: "a JSON body is required" }, 400);
  const validated = validateProspectFilters(body.filters);
  if ("problems" in validated) {
    return c.json({ error: "Invalid prospect filters", problems: validated.problems }, 400);
  }
  const limit = body.limit === undefined || body.limit === null ? undefined : Number(body.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
  }
  const cursor = typeof body.cursor === "string" && body.cursor !== "" ? body.cursor : undefined;
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) {
    return c.json({ total: 0, prospects: [], nextCursor: null });
  }
  try {
    const page = await searchProspectsPage(twentyClient(), {
      dsl: filtersToDsl(validated.filters),
      cursor,
      limit,
    });
    return c.json({ total: page.total, prospects: page.summaries, nextCursor: page.nextCursor });
  } catch (error) {
    if (error instanceof Error && error.name === "TwentyError" && (error as { status?: unknown }).status === 404) {
      return c.json({ total: 0, prospects: [], nextCursor: null });
    }
    return fail(c, error, "Failed to search prospects", 502);
  }
});

inbox.post("/messages/preview", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    agencyPhoneId?: unknown;
    filters?: unknown;
    text?: unknown;
  } | null;
  if (!body) return c.json({ error: "a JSON body is required" }, 400);
  if (typeof body.agencyPhoneId !== "string" || body.agencyPhoneId === "") {
    return c.json({ error: "agencyPhoneId is required" }, 400);
  }
  const validated = validateProspectFilters(body.filters);
  if ("problems" in validated) {
    return c.json({ error: "Invalid prospect filters", problems: validated.problems }, 400);
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return c.json({ error: "text is required" }, 400);
  }
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) {
    return c.json({ total: 0, eligible: 0, skipped: 0, sample: [] });
  }
  try {
    const client = twentyClient();
    const found = findAgencyPhoneRow(await listAgencyPhones(client), body.agencyPhoneId);
    if (!found) return c.json({ error: "Unknown sending number" }, 404);
    const rows = await walkProspectRows(client, filtersToDsl(validated.filters));
    const { eligible, skipped } = splitEligibility(rows);
    return c.json({
      total: rows.length,
      eligible: eligible.length,
      skipped: skipped.length,
      sample: eligible.slice(0, 5),
    });
  } catch (error) {
    return fail(c, error, "Failed to preview the send", 502);
  }
});

inbox.post("/messages/batch-send", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    agencyPhoneId?: unknown;
    filters?: unknown;
    text?: unknown;
    idempotencyKey?: unknown;
  } | null;
  if (!body) return c.json({ error: "a JSON body is required" }, 400);
  if (typeof body.agencyPhoneId !== "string" || body.agencyPhoneId === "") {
    return c.json({ error: "agencyPhoneId is required" }, 400);
  }
  const validated = validateProspectFilters(body.filters);
  if ("problems" in validated) {
    return c.json({ error: "Invalid prospect filters", problems: validated.problems }, 400);
  }
  if (typeof body.text !== "string" || body.text.trim() === "") {
    return c.json({ error: "text is required" }, 400);
  }
  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey === "") {
    return c.json({ error: "idempotencyKey is required" }, 400);
  }
  // Accepted, required, and echoed below as the run correlator: the operator
  // matches a run to its outcomes by it. There is no server dedup store, so
  // a retried key re-reports rather than suppresses; per-recipient outcomes
  // are what make a retry safe to assess.
  const idempotencyKey: string = body.idempotencyKey;
  const text: string = body.text;
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) {
    return c.json({ error: "Twenty is not configured" }, 503);
  }
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
  try {
    const client = twentyClient();
    // Resolved once for the whole run: the operator is the same for every
    // recipient, and each write would otherwise repeat the member lookup.
    const actor = await resolveOperatorActor(c);
    const found = findAgencyPhoneRow(await listAgencyPhones(client), body.agencyPhoneId);
    if (!found) return c.json({ error: "Unknown sending number" }, 404);
    if (!found.messagingProfileId) {
      return c.json(
        {
          error: `${found.phoneNumber} has no messaging profile in Twenty`,
          detail:
            "Set messagingProfileId on the number's agencyPhones record. Blaster does not fall back to a global profile, because the wrong one is rejected by the carrier after acceptance.",
        },
        409,
      );
    }
    const from = found.phoneNumber;
    const numberProfileId: string = found.messagingProfileId;
    const rows = await walkProspectRows(client, filtersToDsl(validated.filters));
    if (rows.length > MAX_BATCH_PROSPECTS) {
      return c.json(
        { error: `Batch too large: ${rows.length} prospects match, the limit is ${MAX_BATCH_PROSPECTS}` },
        400,
      );
    }
    const { eligible, skipped } = splitEligibility(rows);
    const outcomes: Array<{
      prospectId: string;
      phone: string | null;
      status: "sent" | "skipped" | "failed";
      detail?: string | null;
      telnyxId?: string | null;
    }> = skipped.map(({ summary, reason }) => ({
      prospectId: summary.id,
      phone: summary.phone,
      status: "skipped" as const,
      detail: reason,
    }));
    let sent = 0;
    let failed = 0;
    for (const summary of eligible) {
      const to = summary.phone as string;
      const resolution = resolveMessagingProfile(process.env, { to, numberProfileId });
      if (!resolution.profileId) {
        outcomes.push({ prospectId: summary.id, phone: to, status: "failed", detail: "No messaging profile is configured" });
        failed += 1;
        continue;
      }
      try {
        await markProspectOutbound(client, summary.id, "SENDING", actor);
      } catch {
        outcomes.push({ prospectId: summary.id, phone: to, status: "failed", detail: "Could not mark the prospect as sending" });
        failed += 1;
        continue;
      }
      try {
        const sentMessage = await sendMessage({
          apiKey,
          from,
          to,
          text,
          messagingProfileId: resolution.profileId,
        });
        try {
          await markProspectOutbound(client, summary.id, "AWAITING_DELIVERY", actor);
        } catch {
          outcomes.push({
            prospectId: summary.id,
            phone: to,
            status: "sent",
            detail: "Sent, but the prospect stage could not be updated",
            telnyxId: sentMessage.id,
          });
          sent += 1;
          continue;
        }
        outcomes.push({ prospectId: summary.id, phone: to, status: "sent", telnyxId: sentMessage.id });
        sent += 1;
      } catch (error) {
        const detail = error instanceof TelnyxError ? error.message : error instanceof Error ? error.message : String(error);
        try {
          await markProspectOutbound(client, summary.id, "FAILED", actor);
        } catch {
          // Already failing; the send error is the one that matters.
        }
        outcomes.push({ prospectId: summary.id, phone: to, status: "failed", detail });
        failed += 1;
      }
    }
    return c.json({
      agencyPhoneId: body.agencyPhoneId,
      from,
      idempotencyKey,
      total: rows.length,
      sent,
      skipped: skipped.length,
      failed,
      outcomes,
    });
  } catch (error) {
    return fail(c, error, "Failed to run the batch send", 502);
  }
});

app.route("/api", inbox);

/**
 * Number pools.
 *
 * Operator-gated like the inbox, because a pool names provisioned sending
 * numbers and their rate state. The CLI and MCP reach these through the shared
 * `createBlasterApiClient`, so all three surfaces act on the same pool state.
 * Removing a number is a soft removal handled in Convex; this layer only
 * validates the request and maps the Convex result onto a status code.
 */
const pools = new Hono();

pools.get("/pools", requireOperator, async (c) => {
  const result = await listPools();
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to list pools", detail: result.error }, 502);
  return c.json({ count: result.value.length, pools: result.value });
});

pools.post("/pools", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    minSpacingMs?: unknown;
    dailyCapPerNumber?: unknown;
  } | null;
  if (!body || typeof body.name !== "string" || body.name.trim() === "") {
    return c.json({ error: "name is required" }, 400);
  }
  const result = await createPool({
    name: body.name,
    ...(typeof body.minSpacingMs === "number" ? { minSpacingMs: body.minSpacingMs } : {}),
    ...(typeof body.dailyCapPerNumber === "number" ? { dailyCapPerNumber: body.dailyCapPerNumber } : {}),
  });
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to create the pool", detail: result.error }, 502);
  return c.json(result.value, 201);
});

pools.get("/pools/:id", requireOperator, async (c) => {
  const result = await getPool(c.req.param("id"));
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to read the pool", detail: result.error }, 502);
  if (!result.value) return c.json({ error: "Unknown pool" }, 404);
  return c.json(result.value);
});

pools.post("/pools/:id/numbers", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    phoneNumber?: unknown;
    order?: unknown;
  } | null;
  if (!body || typeof body.phoneNumber !== "string" || body.phoneNumber.trim() === "") {
    return c.json({ error: "phoneNumber is required" }, 400);
  }
  const result = await addPoolNumber(
    c.req.param("id"),
    body.phoneNumber,
    typeof body.order === "number" ? body.order : undefined,
  );
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to add the number", detail: result.error }, 502);
  return c.json(result.value);
});

pools.delete("/pools/:id/numbers/:phoneNumber", requireOperator, async (c) => {
  const result = await removePoolNumber(c.req.param("id"), c.req.param("phoneNumber"));
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") {
    const clientMistake = /not in pool|unknown/i.test(result.error);
    return c.json(
      { error: clientMistake ? "That number is not in the pool" : "Failed to remove the number", detail: result.error },
      clientMistake ? 404 : 502,
    );
  }
  return c.json(result.value);
});

pools.put("/pools/:id/numbers", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { order?: unknown } | null;
  if (!body || !Array.isArray(body.order) || body.order.some((item) => typeof item !== "string")) {
    return c.json({ error: "order must be an array of E.164 numbers" }, 400);
  }
  const result = await reorderPoolNumbers(c.req.param("id"), body.order as string[]);
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to reorder the pool", detail: result.error }, 502);
  return c.json(result.value);
});

/**
 * Sequences, for the pool wizard's "assign to a sequence" step.
 *
 * Read-only and operator-gated like the rest of this sub-app. The runner and the
 * sequence builder read sequences directly from Convex; this route exists only
 * so the CLI and MCP can list them through the shared client.
 */
pools.get("/sequences", requireOperator, async (c) => {
  const result = await listSequences();
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to list sequences", detail: result.error }, 502);
  return c.json({ count: result.value.length, sequences: result.value });
});

/**
 * Assign a pool to a sequence, or clear it.
 *
 * An absent `poolId` clears the assignment and restores the sequence's fixed
 * `fromNumber`; that is the one way to undo a pool assignment.
 */
pools.post("/sequences/:id/pool", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { poolId?: unknown } | null;
  const result = await setSequencePool(
    c.req.param("id"),
    typeof body?.poolId === "string" && body.poolId !== "" ? body.poolId : undefined,
  );
  if (result.status === "not-configured") return c.json({ error: "CONVEX_URL is not configured" }, 503);
  if (result.status === "failed") return c.json({ error: "Failed to assign the pool", detail: result.error }, 502);
  return c.json(result.value);
});

app.route("/api", pools);

/** The environment manifest, with each variable's configured state. */
app.get("/api/env", (c) => {
  const variables = describeEnv().map((variable) => ({
    name: variable.name,
    required: variable.required,
    configured: variable.configured,
    consumedBy: variable.consumedBy,
  }));
  return c.json({
    variables,
    missingRequired: missingRequired(),
    uncoveredMessagingProfileCountries: uncoveredCountries(process.env),
  });
});

/** The pipeline breakdown plus the notifications it currently triggers. */
app.get("/api/breakdown", async (c) => {
  // A missing credential is a configuration problem, not a provider failure.
  // Reporting it as 503 with the names says what to do; a 500 does not.
  const unconfigured = ["TWENTY_BASE_URL", "TWENTY_API_KEY"].filter((name) => !process.env[name]);
  if (unconfigured.length > 0) {
    return c.json(
      {
        error: "Twenty is not configured",
        missing: unconfigured,
        hint: "Set the missing variables, or read the pipeline with no workspace by calling the builder directly.",
      },
      503,
    );
  }
  try {
    const result = await readBreakdownFrom(twentyReader(twentyClient()));
    return c.json(result);
  } catch (error) {
    return fail(c, error, "Failed to read the pipeline from Twenty");
  }
});

/** Which messaging profile a recipient resolves to, and why. */
app.get("/api/messaging/profile", (c) => {
  const to = c.req.query("to");
  const recipientCountry = c.req.query("country");
  const resolution = resolveMessagingProfile(process.env, { to, recipientCountry });
  return c.json({ ...resolution, resolvedCountry: normaliseCountry(recipientCountry) ?? normaliseCountry(to) });
});

/** The profiles Telnyx actually has, so configuration gaps are visible. */
app.get("/api/messaging/profiles", async (c) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
  try {
    return c.json({ profiles: await listMessagingProfiles(apiKey) });
  } catch (error) {
    return fail(c, error, "Failed to list messaging profiles");
  }
});

/**
 * Send one SMS.
 *
 * The profile is resolved from the recipient before the send, because a
 * message sent from a profile registered for the wrong jurisdiction is
 * rejected by the carrier after it has already been accepted by Telnyx.
 */
app.post("/api/messages/send", requireOperator, async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    to?: string;
    from?: string;
    text?: string;
  } | null;

  if (!body?.to || !body.text) {
    return c.json({ error: "to and text are required" }, 400);
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);

  // `from` is required by Telnyx. Without a number we cannot guess one, so the
  // caller has to say which sending number to use. It is read first because the
  // profile that follows is bound to that number, not to the recipient.
  if (!body.from) {
    return c.json({ error: "from is required: Blaster will not guess a sending number" }, 400);
  }

  // The sending number's own record decides its profile, and nothing else does.
  // A workspace with several numbers cannot be described by one environment
  // variable, because each number is bought or assigned against its own
  // registration, so a global default either misdescribes the rest or forces
  // every number onto one profile. A caller cannot pass a profile in either: the
  // point is that the workspace knows which profile each number is registered
  // against, and this route is the only place that fact is read.
  const bound = profileBoundToNumber(await agencyPhonesForSending(), body.from);
  if (bound === null) {
    return c.json(
      {
        error: `${body.from} has no messaging profile in Twenty`,
        detail:
          "Set messagingProfileId on the number's agencyPhones record. Blaster does not fall back to a global profile, because the wrong one is rejected by the carrier after acceptance.",
      },
      409,
    );
  }
  const resolution = resolveMessagingProfile(process.env, {
    to: body.to,
    numberProfileId: bound.profileId,
  });
  if (!resolution.profileId) {
    return c.json(
      { error: "No messaging profile is configured", resolution },
      500,
    );
  }

  try {
    const sent = await sendMessage({
      apiKey,
      from: body.from,
      to: body.to,
      text: body.text,
      messagingProfileId: resolution.profileId,
    });
    return c.json({ sent, resolution });
  } catch (error) {
    return fail(c, error, "Failed to send the message", 502);
  }
});

/**
 * Sequence builder.
 *
 * A sequence is validated here before anything is persisted, so a caller gets
 * every problem at once rather than one per round trip. The rules themselves
 * live in packages/core and are shared with the CLI and the MCP server.
 */
app.post("/api/sequences/validate", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Partial<SequenceDraft> | null;
  if (!body) return c.json({ error: "a JSON body is required" }, 400);

  const draft: SequenceDraft = {
    name: body.name ?? "",
    fromNumber: body.fromNumber ?? "",
    numberProfileId: body.numberProfileId,
    campaignId: body.campaignId,
    options: { ...DEFAULT_OPTIONS, ...body.options },
    steps: (body.steps ?? []).map((step) => ({
      text: step.text ?? "",
      delayHours: step.delayHours ?? 0,
      isStop: step.isStop ?? false,
    })),
  };

  const problems = validateDraft(draft);
  return c.json({ valid: problems.length === 0, problems, summary: summarise(draft) });
});

/**
 * Dry run: what would happen to each recipient at the current step.
 *
 * This is the check an operator wants before turning a sequence on, and it
 * needs no Telnyx credentials because it never sends.
 */
app.post("/api/sequences/preview", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    options?: Partial<typeof DEFAULT_OPTIONS>;
    steps?: SequenceStepDraft[];
    recipients?: Array<Recipient & { cursor?: number }>;
    fromNumber?: string;
    numberProfileId?: string;
  } | null;
  if (!body?.recipients) return c.json({ error: "recipients is required" }, 400);

  const options = { ...DEFAULT_OPTIONS, ...body.options };
  const steps = body.steps ?? [{ text: "", delayHours: 0, isStop: false }];

  const rows = body.recipients.map((recipient) => {
    const verdict = evaluateEligibility(process.env, options, recipient);
    return {
      recipientId: recipient.id,
      eligible: verdict.eligible,
      reason: verdict.reason,
      detail: verdict.detail,
      country: verdict.profile?.country ?? normaliseCountry(recipient.to),
      profileId: verdict.profile?.profileId ?? null,
      // The body this recipient would receive, so a dry run shows the message
      // and not just a verdict about it.
      text: verdict.eligible ? stepText(steps, recipient.cursor ?? 0) : null,
    };
  });

  const ready = rows.filter((row) => row.eligible);
  const skipped = rows.filter((row) => !row.eligible);
  return c.json({
    total: rows.length,
    ready: ready.length,
    skipped: skipped.length,
    // Grouped so a bulk send shows one reason rather than N identical lines.
    skipReasons: skipped.reduce<Record<string, number>>((acc, row) => {
      const key = row.reason ?? "unknown";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    rows,
  });
});

/**
 * Operator auth against Twenty (Twenty is the identity provider).
 *
 * The browser never holds the client secret and never depends on Twenty's
 * CORS posture: it builds the authorize redirect from public config,
 * then redeems the code through this proxy. Tokens live in the browser
 * session; the secret never leaves the server.
 */
app.get("/api/auth/config", async (c) => {
  const config = loadOAuthConfig();
  if (!config) {
    console.log("[auth] GET /api/auth/config -> 500 (OAuth not configured)");
    return c.json({ error: "Twenty OAuth is not configured" }, 500);
  }
  try {
    const endpoints = await oauthEndpoints(config.baseUrl);
    console.log(`[auth] GET /api/auth/config -> client=${config.clientId} redirect=${config.redirectUri}`);
    return c.json({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      scope: config.scope,
    });
  } catch (error) {
    return fail(c, error, "Failed to read Twenty OAuth discovery");
  }
});

app.post("/api/auth/token", async (c) => {
  const config = loadOAuthConfig();
  if (!config) return c.json({ error: "Twenty OAuth is not configured" }, 500);
  const body = (await c.req.json().catch(() => null)) as {
    code?: string;
    verifier?: string;
    redirectUri?: string;
  } | null;
  if (!body?.code || !body.verifier) {
    return c.json({ error: "code and verifier are required" }, 400);
  }
  try {
    const tokens = await exchangeAuthorizationCode(config, {
      code: body.code,
      verifier: body.verifier,
      redirectUri: body.redirectUri,
    });
    return c.json({ tokens });
  } catch (error) {
    return fail(c, error, "Failed to exchange the authorization code", 502);
  }
});

app.post("/api/auth/refresh", async (c) => {
  const config = loadOAuthConfig();
  if (!config) return c.json({ error: "Twenty OAuth is not configured" }, 500);
  const body = (await c.req.json().catch(() => null)) as { refreshToken?: string } | null;
  if (!body?.refreshToken) return c.json({ error: "refreshToken is required" }, 400);
  try {
    const tokens = await refreshOperatorToken(config, body.refreshToken);
    return c.json({ tokens });
  } catch (error) {
    return fail(c, error, "Failed to refresh the operator token", 502);
  }
});

/** Who is calling: introspect the Bearer token, 401 when it is not live. */
/**
 * Who is calling: introspect the Bearer token, 401 when it is not live.
 *
 * Also reports which workspace member the token resolved to, because that is
 * the answer to "whose records am I about to write". `memberResolved: false`
 * with an `applicationToken: true` is the signature of a deployment where the
 * auth-guard is presenting the token endpoint with basic credentials: Twenty
 * then issues an APPLICATION_ACCESS token with no human in it, sign-in appears
 * to work, and nothing is ever attributed. See docs/identity.md.
 */
app.get("/api/auth/me", async (c) => {
  const config = loadOAuthConfig();
  if (!config) return c.json({ error: "Twenty OAuth is not configured" }, 500);
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return c.json({ error: "Bearer token is required" }, 401);
  try {
    const result = await checkOperatorToken(config, token);
    if (!result.active) return c.json({ error: "Token is not active" }, 401);
    const claims = claimsOfToken(token);
    const member = process.env.TWENTY_BASE_URL && process.env.TWENTY_API_KEY
      ? await resolveMemberIdentity(new TwentyClient(), { claims, introspectionClaims: result.claims })
      : null;
    // A token that names no user is an application token, not an unattributed
    // human. The two need different fixes, so they are reported differently.
    const applicationToken = !claims?.userId && !claims?.userWorkspaceId;
    console.log(
      `[auth] GET /api/auth/me -> active memberResolved=${member !== null} ` +
        `resolvedVia=${member?.resolvedVia ?? "none"} applicationToken=${applicationToken}` +
        (member ? ` member=${member.email ?? member.workspaceMemberId}` : ""),
    );
    return c.json({
      active: true,
      username: result.username,
      scope: result.scope,
      memberResolved: member !== null,
      resolvedVia: member?.resolvedVia ?? null,
      applicationToken,
      ...(member
        ? {
            workspaceMemberId: member.workspaceMemberId,
            memberName: member.name,
            memberEmail: member.email,
          }
        : {}),
    });
  } catch (error) {
    return fail(c, error, "Failed to validate the operator token", 502);
  }
});

/**
 * Phone-number inventory: search, purchase, and Twenty sync.
 *
 * Search and purchase go through the official `telnyx` SDK in
 * `@blaster/core` (`client.availablePhoneNumbers.list`,
 * `client.numberOrders.create`), the same endpoints the Convex
 * `phoneNumbers` actions use, so an agent can buy a number from any surface.
 * Twenty `agencyPhones` is the operator-visible mirror: a purchase optionally
 * upserts each number there, and the sync route moves rows in either
 * direction keyed on the E.164 number.
 */
app.get("/api/numbers/search", async (c) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
  const limitRaw = c.req.query("limit");
  const featuresRaw = c.req.query("features");
  try {
    const results = await searchAvailableNumbers(apiKey, {
      countryCode: c.req.query("countryCode") ?? c.req.query("country"),
      numberType: (c.req.query("numberType") ?? c.req.query("type") ?? undefined) as NumberType | undefined,
      features: featuresRaw ? (featuresRaw.split(",").map((f) => f.trim()).filter(Boolean) as NumberFeature[]) : undefined,
      limit: limitRaw ? Number(limitRaw) : undefined,
      locality: c.req.query("locality"),
      administrativeArea: c.req.query("administrativeArea"),
      contains: c.req.query("contains"),
      startsWith: c.req.query("startsWith"),
      endsWith: c.req.query("endsWith"),
    });
    return c.json({ count: results.length, numbers: results });
  } catch (error) {
    return fail(c, error, "Failed to search available numbers", 502);
  }
});

app.post("/api/numbers/purchase", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    phoneNumbers?: string[];
    phoneNumber?: string;
    messagingProfileId?: string;
    customerReference?: string;
    syncToTwenty?: boolean;
  } | null;
  const numbers = body?.phoneNumbers ?? (body?.phoneNumber ? [body.phoneNumber] : []);
  if (!numbers || numbers.length === 0) {
    return c.json({ error: "phoneNumbers (or phoneNumber) is required" }, 400);
  }
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
  try {
    const order = await createNumberOrder(apiKey, {
      phoneNumbers: numbers,
      messagingProfileId: body?.messagingProfileId,
      customerReference: body?.customerReference,
    });
    let twenty: Array<unknown> = [];
    if (body?.syncToTwenty !== false && process.env.TWENTY_BASE_URL && process.env.TWENTY_API_KEY) {
      const client = twentyClient();
      // Null on this route when nobody is signed in, which is not a failure:
      // the number is still recorded, just not attributed to a person.
      const actor = await resolveOperatorActor(c);
      twenty = [];
      for (const purchased of order.phoneNumbers) {
        const record = await upsertAgencyPhone(
          client,
          {
            phoneNumber: purchased.phoneNumber,
            messagingProfileId: order.messagingProfileId ?? body?.messagingProfileId ?? null,
            countryCode: purchased.countryCode,
            numberType: purchased.numberType,
            telnyxNumberId: purchased.id,
            orderId: order.id,
            status: purchased.status,
          },
          actor,
        );
        twenty.push(record);
      }
    }
    return c.json({ order, twenty, syncedToTwenty: twenty.length });
  } catch (error) {
    return fail(c, error, "Failed to purchase phone numbers", 502);
  }
});

/** Numbers already owned on the Telnyx account, with messaging bindings. */
app.get("/api/numbers/owned", async (c) => {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
  try {
    const numbers = await listOwnedNumbers(apiKey);
    return c.json({ count: numbers.length, numbers });
  } catch (error) {
    return fail(c, error, "Failed to list owned numbers", 502);
  }
});

/**
 * Operator mirror of owned numbers.
 * `?source=twenty` (default) reads Twenty `agencyPhones`;
 * `?source=telnyx` reads the Telnyx account instead.
 */
app.get("/api/phones", async (c) => {
  const source = c.req.query("source") ?? "twenty";
  try {
    if (source === "telnyx") {
      const apiKey = process.env.TELNYX_API_KEY;
      if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);
      const numbers = await listOwnedNumbers(apiKey);
      return c.json({ source, count: numbers.length, phones: numbers });
    }
    const rows = await listAgencyPhones(twentyClient());
    return c.json({ source, count: rows.length, phones: rows.map(fromAgencyPhoneRecord) });
  } catch (error) {
    return fail(c, error, "Failed to list phones");
  }
});

/**
 * Move phone rows between Convex and Twenty.
 * The API has no Convex client, so it operates on payloads: pass Convex rows
 * as `phones` with `direction=convex-to-twenty` to upsert them into Twenty,
 * or call with `direction=twenty-to-convex` to receive the Twenty rows the
 * caller should store via the Convex `importTwentyPhones` mutation.
 */
app.post("/api/phones/sync", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    direction?: "convex-to-twenty" | "twenty-to-convex";
    phones?: Array<Record<string, unknown>>;
  } | null;
  const direction = body?.direction ?? "convex-to-twenty";
  try {
    const twentyRows = await listAgencyPhones(twentyClient());
    const twentyPhones = twentyRows.map(fromAgencyPhoneRecord);
    if (direction === "twenty-to-convex") {
      return c.json({ direction, count: twentyPhones.length, phones: twentyPhones });
    }
    const convexPhones = (body?.phones ?? []).map((row) => ({
      phoneNumber: String(row.phoneNumber ?? row.phone_number ?? ""),
      messagingProfileId: (row.messagingProfileId ?? row.messaging_profile_id ?? null) as string | null,
      countryCode: (row.countryCode ?? row.country_code ?? null) as string | null,
      numberType: (row.numberType ?? row.number_type ?? null) as string | null,
      telnyxNumberId: (row.telnyxNumberId ?? row.telnyx_number_id ?? null) as string | null,
      orderId: (row.orderId ?? row.order_id ?? null) as string | null,
      status: (row.status ?? null) as string | null,
    }));
    const plan = planPhoneSync(
      convexPhones.filter((row) => row.phoneNumber),
      twentyPhones,
    );
    const client = twentyClient();
    const actor = await resolveOperatorActor(c);
    const upserted = [];
    for (const row of plan.toCreateInTwenty) {
      upserted.push(await upsertAgencyPhone(client, row, actor));
    }
    return c.json({
      direction,
      toCreateInTwenty: plan.toCreateInTwenty.length,
      toStoreInConvex: plan.toStoreInConvex.length,
      upserted: upserted.length,
      toStoreInConvexPhones: plan.toStoreInConvex,
    });
  } catch (error) {
    return fail(c, error, "Failed to sync phones");
  }
});

/**
 * Inbound Telnyx webhook.
 *
 * Signature verification is the goal and the Convex telnyx component owns it.
 * Until a public key is configured this falls back to a shared-secret gate,
 * which is weaker and says so in the response.
 */
/**
 * The number registries consulted before an inbound event is stored.
 *
 * Cached briefly because the webhook has a two-second acknowledgement budget
 * and these are all network calls. A number bought a moment ago may be missing
 * for up to the TTL; Telnyx retries three times, so the message recovers on its
 * own rather than being lost to a cache that was warm a minute too early.
 */
/** Long enough to read on a lock screen, short enough to stay useful. */
const NOTIFY_PREVIEW_LENGTH = 120;

const OWNERSHIP_TTL_MS = 60_000;
let ownershipCache: { at: number; sources: OwnershipSources } | null = null;

async function ownedSources(): Promise<OwnershipSources> {
  if (ownershipCache && Date.now() - ownershipCache.at < OWNERSHIP_TTL_MS) {
    return ownershipCache.sources;
  }
  const apiKey = process.env.TELNYX_API_KEY;
  const telnyx = apiKey ? await listOwnedNumbers(apiKey).catch(() => null) : null;
  // Twenty rows come back as generic records, so they go through the same
  // mapper the phone views use rather than being read field by field here.
  const twenty =
    process.env.TWENTY_BASE_URL && process.env.TWENTY_API_KEY
      ? await listAgencyPhones(twentyClient())
          .then((rows) => rows.map(fromAgencyPhoneRecord))
          .catch(() => null)
      : null;
  // The Convex purchase ledger is the third registry. It can be ahead of the
  // other two for a number bought through the backend, or added to a pool before
  // a sync, and a reply to a number owned only here would otherwise be refused
  // as not-owned and dropped.
  const ledger = await listLedgerNumbers();
  const convex = ledger.status === "ok" ? ledger.rows : null;
  const sources: OwnershipSources = { telnyx, twenty, convex };
  ownershipCache = { at: Date.now(), sources };
  return sources;
}

/**
 * Inbound Telnyx webhook.
 *
 * The order here is the whole contract, and each step exists because the one
 * before it cannot be trusted on its own:
 *
 *   1. Verify the signature over the raw bytes, or refuse. A public URL with
 *      no verification is how a stranger fills our history with their threads.
 *   2. Check the event is addressed to a number we own. The `to` field is
 *      attacker-controlled, so it is a claim to be checked, not an answer.
 *   3. Store it, deduplicated on the Telnyx event id.
 *   4. Acknowledge only now. Telnyx needs 2xx inside two seconds and retries
 *      three times, so a non-2xx is how a transient failure earns a retry,
 *      and acknowledging an event we failed to store loses it permanently.
 */
app.post("/api/webhooks/telnyx", async (c) => {
  const rawBody = await c.req.text();

  // The signature covers these exact bytes, so nothing may re-serialize them.
  // Headers are converted with forEach rather than Object.entries: a Headers
  // instance keeps its pairs in internal slots, so Object.entries(headers) is
  // empty and the SDK would find no signature and reject every real event.
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const verification = await verifyTelnyxWebhook({
    rawBody,
    headers,
    publicKey: process.env.TELNYX_PUBLIC_KEY,
    sharedToken: process.env.TELNYX_WEBHOOK_TOKEN,
    providedToken: c.req.query("token"),
  });
  if (verification.outcome === "invalid") {
    return c.json({ ok: false, error: "signature verification failed", detail: verification.reason }, 401);
  }
  if (verification.outcome === "unavailable") {
    // A misconfiguration, not an attack: refuse rather than accept unverified
    // input, and let the retry (or the failover URL) carry the event.
    return c.json({ ok: false, error: verification.reason }, 503);
  }

  let parsed: TelnyxWebhookEvent;
  try {
    parsed = JSON.parse(rawBody || "{}") as TelnyxWebhookEvent;
  } catch {
    return c.json({ ok: false, error: "body is not JSON" }, 400);
  }
  const eventType = eventTypeOf(parsed);

  if (isInboundEvent(parsed)) {
    const inbound = readInboundMessage(parsed);
    if (!inbound) {
      // Verified, but it names no counterpart, so there is no conversation to
      // attach it to. Acked so Telnyx stops retrying something unfixable.
      return c.json({ ok: true, event: eventType, stored: false, reason: "unusable event" }, 200);
    }

    const resolution = resolveOwnedDestination(inbound.to, await ownedSources());
    if (resolution.status === "no-sources") {
      return c.json({ ok: false, error: "no number registry configured to verify ownership" }, 503);
    }
    if (resolution.status === "not-owned") {
      // Permanent: retrying will not make the number ours, and a 2xx stops
      // Telnyx burning its three attempts on a forgery.
      return c.json(
        { ok: true, event: eventType, stored: false, reason: "destination is not a number we own" },
        202,
      );
    }

    // Opt-out is decided here with the deterministic classifier, never guessed
    // in the mutation: only the confidence-1 rule baseline may stop harder than
    // a reply, because anything probabilistic belongs behind a human confirm.
    const optedOut = classifyMessageRules(inbound.body).state === "opt_out";
    const result = await recordInboundMessage({
      from: inbound.from,
      to: inbound.to,
      body: inbound.body,
      ...(inbound.telnyxMessageId ? { telnyxMessageId: inbound.telnyxMessageId } : {}),
      ...(inbound.providerEventId ? { providerEventId: inbound.providerEventId } : {}),
      receivedAt: inbound.receivedAt,
      ...(optedOut ? { optedOut: true as const } : {}),
      ...(inbound.media ? { media: inbound.media } : {}),
    });
    if (result.status === "failed") {
      return c.json({ ok: false, error: "could not store the message", detail: result.error }, 500);
    }
    if (result.status === "not-configured") {
      return c.json({ ok: false, error: "CONVEX_URL is not configured" }, 503);
    }

    // The reply stopped the sequence inside the same Convex transaction that
    // stored it, and only for a genuinely new event: a redelivery returned
    // "duplicate" above and never reached this line, so it cannot notify twice.
    const stopped = result.status === "stored" ? (result.stoppedEnrollments ?? []) : [];
    if (result.status === "stored") {
      await notifyReply(inbound, stopped);
    }
    return c.json(
      {
        ok: true,
        event: eventType,
        verification: verification.outcome,
        stored: result.status === "stored",
        duplicate: result.status === "duplicate",
        conversationId: result.conversationId,
        messageId: result.messageId,
        // Named in the response so a test can assert the stop without reading
        // the database, and so an operator can see why a sequence went quiet.
        stoppedEnrollments: stopped.length,
      },
      200,
    );
  }

  // Outbound lifecycle events update delivery state on a message we sent. There
  // is nothing to store for them, and a redelivery is answered as a no-op.
  const status = statusOfOutboundEvent(parsed);
  if (status) {
    const messageId = messageIdOf(parsed);
    if (messageId) {
      const applied = await applyOutboundStatus(messageId, readOutboundStatus(status), eventType);
      if (applied.status === "failed") {
        return c.json({ ok: false, error: "could not update delivery state", detail: applied.error }, 500);
      }
      if (applied.status === "not-configured") {
        return c.json({ ok: false, error: "CONVEX_URL is not configured" }, 503);
      }
      return c.json({ ok: true, event: eventType, delivery: applied.status }, 200);
    }
  }

  // Call recordings and transcripts. These are a different family of event from
  // the conversation ones above: they have no counterpart message and no thread,
  // they land on the agencyCalls object rather than in Convex, and they carry no
  // operator — a webhook is machine to machine, so crediting a call to whichever
  // operator signed in most recently would be a worse lie than leaving it to
  // Twenty's API actor.
  if (isCallEvent(eventType)) {
    if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) {
      return c.json({ ok: false, error: "Twenty is not configured" }, 503);
    }
    const call = await handleCallEvent(
      twentyClient(),
      eventType,
      parsed.data?.payload as CallRecordingPayload,
    );
    // An unprovisioned object is a configuration state, not a bad event: a
    // retry cannot provision it, but the operator can, so this is 503 rather than
    // an ack that discards the recording permanently.
    if (call.outcome === "object-not-provisioned") {
      return c.json({ ok: false, event: eventType, error: call.detail }, 503);
    }
    return c.json({ ok: true, event: eventType, call }, 200);
  }

  return c.json({ ok: true, event: eventType, stored: false, reason: "no action for this event" }, 200);
});

const port = Number(process.env.PORT ?? 4180);

// Listen only when this file is the process entry point. Importing the app to
// test a route must not bind a port, and `export default app` is what every
// other surface (Hono tests, the webhook probe) needs.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  // Local development loads the repo-root `.env.local` into `process.env`.
  // Nothing in this process reads an env file on its own: `loadOAuthConfig`
  // and every other reader take `process.env` as-is. Without this, `pnpm dev`
  // runs on the bare shell environment and every provider reports "not
  // configured" even though the values sit in `.env.local` two levels up.
  //
  // This runs only for the real server process, never on import: the test
  // suite imports this module to drive routes, and loading a developer's
  // real keys into that process would break fixtures that construct a
  // misconfigured instance by deleting vars. `loadEnvFile` only fills gaps,
  // so real environment (Vercel, exported shell vars) always wins; on a
  // deployment the file is absent and this is a no-op. PORT is read at
  // module level above, so a PORT in the file would not apply — port
  // assignment belongs to the environment, not the local file.
  const repoRootEnvFile = fileURLToPath(new URL("../../../.env.local", import.meta.url));
  if (existsSync(repoRootEnvFile)) {
    process.loadEnvFile(repoRootEnvFile);
    console.log(`[env] loaded ${repoRootEnvFile}`);
  } else {
    console.log("[env] no repo-root .env.local; using the process environment as-is");
  }
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`blaster listening on http://localhost:${info.port}`);
    // Startup identity banner: shows which providers the process can see.
    // Only public values are printed (client id, redirect, scope, host);
    // keys, secrets and passwords are never logged, only present/absent.
    const oauth = loadOAuthConfig();
    if (!oauth) {
      console.log("[auth] Twenty OAuth is NOT configured (base URL, client id, or redirect URI missing)");
    } else {
      console.log(
        `[auth] OAuth client=${oauth.clientId} redirect=${oauth.redirectUri} ` +
          `scope="${oauth.scope}" discovery=${oauth.baseUrl} basicAuth=${oauth.basicAuth ? "set" : "unset"} secret=${oauth.clientSecret ? "set (confidential?)" : "unset (public PKCE)"}`,
      );
    }
    const twentyRest = Boolean(process.env.TWENTY_BASE_URL && process.env.TWENTY_API_KEY);
    console.log(`[twenty] REST/GraphQL ${twentyRest ? "configured" : "NOT configured"} (api key ${process.env.TWENTY_API_KEY ? "set" : "missing"})`);
  });
}

export default app;
