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
import { pathToFileURL } from "node:url";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  DEFAULT_OPTIONS,
  TwentyClient,
  createNumberOrder,
  describeEnv,
  evaluateEligibility,
  fromAgencyPhoneRecord,
  listAgencyPhones,
  listOwnedNumbers,
  missingRequired,
  normaliseCountry,
  planPhoneSync,
  resolveMessagingProfile,
  searchAvailableNumbers,
  stepText,
  summarise,
  uncoveredCountries,
  upsertAgencyPhone,
  validateDraft,
  type NumberFeature,
  type NumberType,
  type Recipient,
  type SequenceDraft,
  type SequenceStepDraft,
} from "@blaster/core";
import { TelnyxError, listMessagingProfiles, sendMessage } from "./lib/telnyx/messaging/index.ts";
import { readBreakdownFrom, twentyReader } from "./lib/pipeline/breakdown/index.ts";
import { applyOutboundStatus, conversationMessages, listConversations, recordInboundMessage } from "./lib/convex/index.ts";
import { requireOperator } from "./lib/auth/operator/index.ts";
import {
  eventTypeOf,
  isInboundEvent,
  messageIdOf,
  readInboundMessage,
  readOutboundStatus,
  resolveOwnedDestination,
  statusOfOutboundEvent,
  verifyTelnyxWebhook,
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
  if (error instanceof Error && error.name === "TwentyError") {
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

app.route("/api", inbox);

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
app.post("/api/messages/send", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    to?: string;
    from?: string;
    text?: string;
    numberProfileId?: string;
  } | null;

  if (!body?.to || !body.text) {
    return c.json({ error: "to and text are required" }, 400);
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return c.json({ error: "TELNYX_API_KEY is not configured" }, 500);

  const resolution = resolveMessagingProfile(process.env, {
    to: body.to,
    numberProfileId: body.numberProfileId,
  });
  if (!resolution.profileId) {
    return c.json(
      { error: "No messaging profile is configured", resolution },
      500,
    );
  }

  // `from` is required by Telnyx. Without a number we cannot guess one, so the
  // caller has to say which sending number to use.
  if (!body.from) {
    return c.json({ error: "from is required: Blaster will not guess a sending number" }, 400);
  }

  try {
    const sent = await sendMessage({
      apiKey,
      from: body.from,
      to: body.to,
      text: body.text,
      messagingProfileId: resolution.profileId,
    });
    // A fallback warning travels with the response rather than being logged and
    // dropped, so the caller can see a misconfigured jurisdiction immediately.
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
  if (!config) return c.json({ error: "Twenty OAuth is not configured" }, 500);
  try {
    const endpoints = await oauthEndpoints(config.baseUrl);
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
app.get("/api/auth/me", async (c) => {
  const config = loadOAuthConfig();
  if (!config) return c.json({ error: "Twenty OAuth is not configured" }, 500);
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return c.json({ error: "Bearer token is required" }, 401);
  try {
    const result = await checkOperatorToken(config, token);
    if (!result.active) return c.json({ error: "Token is not active" }, 401);
    return c.json({ active: true, username: result.username, scope: result.scope });
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
    const upserted = [];
    for (const row of plan.toCreateInTwenty) {
      upserted.push(await upsertAgencyPhone(client, row));
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
  const sources: OwnershipSources = { telnyx, twenty };
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
 *      three times, so a non-2xx is how a transient failure earns a retry —”
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

    const result = await recordInboundMessage({
      from: inbound.from,
      to: inbound.to,
      body: inbound.body,
      ...(inbound.telnyxMessageId ? { telnyxMessageId: inbound.telnyxMessageId } : {}),
      ...(inbound.providerEventId ? { providerEventId: inbound.providerEventId } : {}),
      receivedAt: inbound.receivedAt,
      ...(inbound.media ? { media: inbound.media } : {}),
    });
    if (result.status === "failed") {
      return c.json({ ok: false, error: "could not store the message", detail: result.error }, 500);
    }
    if (result.status === "not-configured") {
      return c.json({ ok: false, error: "CONVEX_URL is not configured" }, 503);
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

  return c.json({ ok: true, event: eventType, stored: false, reason: "no action for this event" }, 200);
});

const port = Number(process.env.PORT ?? 4180);

// Listen only when this file is the process entry point. Importing the app to
// test a route must not bind a port, and `export default app` is what every
// other surface (Hono tests, the webhook probe) needs.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`blaster listening on http://localhost:${info.port}`);
  });
}

export default app;
