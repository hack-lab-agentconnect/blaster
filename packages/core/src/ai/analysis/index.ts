/**
 * Grading a call transcript with a single OpenAI-compatible provider.
 *
 * Provider-neutral on purpose: any endpoint that speaks
 * `POST {base}/chat/completions` works, so this is OpenAI by default and any
 * gateway or local model by configuration. There is no SDK because the only
 * endpoint used is one POST of a two-message conversation, and a dependency for
 * that is a dependency to keep current for no benefit.
 *
 * Throws when unconfigured or when the provider call fails. Callers decide
 * whether that surfaces to a human (a manual re-analyse) or is swallowed (a
 * webhook, where the transcript is already saved and the enrichment is optional).
 *
 * Sentiment throughout is the *prospect's*, never the agent's. That is the whole
 * point of grading a call, and the prompt says so explicitly because a model
 * asked for "sentiment" will otherwise answer about whoever spoke last.
 */

import {
  clamp,
  clampInt,
  extractJson,
  normalizeKeyPoints,
  normalizeSentiment,
  score15,
} from "./helpers/index.ts";
import type { CallAnalysis } from "./types.ts";

export * from "./helpers/index.ts";
export type { AiSentiment, CallAnalysis, CallQualityScores } from "./types.ts";

export interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
/** Long enough for a full call, short enough to stay inside a token budget. */
const MAX_TRANSCRIPT_CHARS = 12_000;
const MIN_TRANSCRIPT_CHARS = 10;
const MAX_SUMMARY_CHARS = 1000;

export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  return {
    apiKey: env.OPENAI_API_KEY || "",
    baseUrl: (env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: env.OPENAI_ANALYSIS_MODEL || DEFAULT_MODEL,
  };
}

/** False means "not configured", which is a reason to skip, not to fail. */
export function isAiConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

const SYSTEM_PROMPT = [
  "You analyze cold-call transcripts for a sales dialer.",
  "Reply with JSON only, no markdown, no commentary:",
  '{"summary": string (1-2 sentences), "sentiment": "POSITIVE"|"NEUTRAL"|"NEGATIVE"|"MIXED",',
  '"score": number 0-100 (how well the call went / how the prospect felt),',
  '"scores": {"conversion": 1-5 (conversion probability), "politeness": 1-5 (agent politeness and rapport),',
  '"questioning": 1-5 (questioning effectiveness), "engagement": 1-5 (contact engagement), "sentiment": 1-5 (prospect sentiment)},',
  '"keyPoints": string[] (max 5 short bullets), "confidence": number 0-1}.',
  "Sentiment reflects the PROSPECT, not the agent. Score <40 = bad, 40-69 = neutral, 70+ = good.",
].join(" ");

function buildUserMessage(
  transcript: string,
  meta?: { direction?: string | null; durationSeconds?: number | null },
): string {
  return [
    `Direction: ${meta?.direction || "unknown"}.`,
    typeof meta?.durationSeconds === "number" ? `Duration: ${meta.durationSeconds}s.` : null,
    "Transcript:",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Analyse one transcript.
 *
 * The response is normalised rather than trusted, so a partial or malformed
 * answer still produces a usable record. It throws only when there is nothing to
 * normalise: no key, no transcript, or a provider that did not answer with JSON.
 */
export async function analyzeCallTranscript(
  transcript: string,
  meta?: { direction?: string | null; durationSeconds?: number | null },
  options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<CallAnalysis> {
  const { apiKey, baseUrl, model } = aiConfig(options.env);
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const clean = transcript.trim().slice(0, MAX_TRANSCRIPT_CHARS);
  if (clean.length < MIN_TRANSCRIPT_CHARS) throw new Error("Transcript is too short to analyze");

  const send = options.fetchFn ?? fetch;
  const response = await send(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      // Low, because the same transcript should grade the same way twice.
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserMessage(clean, meta) },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AI provider answered ${response.status}: ${body.slice(0, 200)}`);
  }

  const payload = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = payload.choices?.[0]?.message?.content ?? "";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
  } catch {
    throw new Error("AI provider returned a response that was not JSON");
  }

  const rawScores = (parsed.scores ?? {}) as Record<string, unknown>;
  // A missing dimension falls back to the overall score mapped onto 1-5, rather
  // than to a flat 3 that would look like a considered answer.
  const fallback15 = score15(parsed.score);
  const summary =
    String(parsed.summary ?? "").trim().slice(0, MAX_SUMMARY_CHARS) || "No summary returned.";

  return {
    summary,
    sentiment: normalizeSentiment(parsed.sentiment),
    score: Math.round(clamp(parsed.score, 0, 100, 50)),
    scores: {
      conversion: clampInt(rawScores.conversion, 1, 5, fallback15),
      politeness: clampInt(rawScores.politeness, 1, 5, fallback15),
      questioning: clampInt(rawScores.questioning, 1, 5, fallback15),
      engagement: clampInt(rawScores.engagement, 1, 5, fallback15),
      sentiment: clampInt(rawScores.sentiment, 1, 5, fallback15),
    },
    keyPoints: normalizeKeyPoints(parsed.keyPoints),
    confidence: clamp(parsed.confidence, 0, 1, 0.5),
    model,
  };
}
