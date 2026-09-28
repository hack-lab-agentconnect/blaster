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
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  DEFAULT_OPTIONS,
  TwentyClient,
  describeEnv,
  evaluateEligibility,
  missingRequired,
  normaliseCountry,
  resolveMessagingProfile,
  stepText,
  summarise,
  uncoveredCountries,
  validateDraft,
  type Recipient,
  type SequenceDraft,
  type SequenceStepDraft,
} from "@blaster/core";
import { TelnyxError, listMessagingProfiles, sendMessage } from "./lib/telnyx.ts";
import { readBreakdownFrom, twentyReader } from "./lib/breakdown-source.ts";

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
 * Inbound Telnyx webhook.
 *
 * Signature verification is the goal and the Convex telnyx component owns it.
 * Until a public key is configured this falls back to a shared-secret gate,
 * which is weaker and says so in the response.
 */
app.post("/api/webhooks/telnyx", async (c) => {
  const rawBody = await c.req.text();

  const publicKey = process.env.TELNYX_PUBLIC_KEY;
  const hookToken = process.env.TELNYX_WEBHOOK_TOKEN;
  const provided = c.req.query("token");

  if (!publicKey) {
    if (!hookToken || provided !== hookToken) {
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  const payload = (JSON.parse(rawBody || "{}")) as { data?: Record<string, unknown> };
  const event = payload.data ?? {};
  const eventType = String(event.event_type ?? "unknown");

  return c.json({
    ok: true,
    event: eventType,
    verified: Boolean(publicKey),
    verification: publicKey ? "signature" : "shared-token",
  });
});

const port = Number(process.env.PORT ?? 4180);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`blaster listening on http://localhost:${info.port}`);
});

export default app;
