/**
 * Turning whatever the model returned into the shape we promised.
 *
 * All pure, and all defensive. A language model asked for JSON will sometimes
 * wrap it in a code fence, sometimes add a sentence of commentary, sometimes
 * return the number as a string, and sometimes invent a sentiment that is not in
 * the enum. None of those should cost a call its analysis, so each is normalised
 * here rather than validated at the call site.
 */

import type { AiSentiment } from "../types.ts";

export const SENTIMENTS: readonly AiSentiment[] = [
  "POSITIVE",
  "NEUTRAL",
  "NEGATIVE",
  "MIXED",
];

/** NEUTRAL is the fallback because it is the one answer that is never wrong. */
export function normalizeSentiment(raw: unknown): AiSentiment {
  const value = String(raw ?? "").trim().toUpperCase();
  return (SENTIMENTS as string[]).includes(value) ? (value as AiSentiment) : "NEUTRAL";
}

/** Coerce to a finite number in range. Accepts numeric strings, which models emit. */
export function clamp(raw: unknown, min: number, max: number, fallback: number): number {
  const value = typeof raw === "string" ? Number(raw) : (raw as number);
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clamp(raw, min, max, fallback));
}

/**
 * Pull the JSON object out of a model response.
 *
 * Handles the fenced block, leading and trailing prose, and the empty response.
 * A response with no braces is returned as-is so the caller's parse error names
 * the real problem instead of reporting "unexpected end of input" on a string we
 * already mangled.
 */
export function extractJson(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fence ? (fence[1] as string) : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

/** The overall 0-100 score mapped onto the 1-5 scale the sub-scores use. */
export function score15(raw: unknown): number {
  return Math.min(5, Math.max(1, Math.round(clamp(raw, 0, 100, 50) / 20)));
}

/** At most five non-empty bullet strings. */
export function normalizeKeyPoints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((point) => String(point).trim())
    .filter((point) => point !== "")
    .slice(0, 5);
}
