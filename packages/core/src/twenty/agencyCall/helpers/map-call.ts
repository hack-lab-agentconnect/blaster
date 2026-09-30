/**
 * Turning a Telnyx call event into the Twenty patch that records it.
 *
 * All pure. Telnyx's payload has grown several aliases for the same value over
 * time (`recording_id` vs `recording_ids[0]`, `transcript` vs
 * `transcription_text` vs `text`), so the alias handling lives here where it can
 * be tested against every spelling, rather than being repeated at each call site.
 */

import type { CallAnalysis } from "../../../ai/analysis/types.ts";

/** Telnyx `call.recording.*` payloads, as they actually arrive. */
export interface CallRecordingPayload {
  call_control_id?: string;
  call_session_id?: string;
  recording_id?: string;
  recording_ids?: string[];
  recording_urls?: { mp3?: string; wav?: string };
  client_state?: string;
  from?: string;
  to?: string;
  direction?: string;
}

export interface TranscriptionPayload extends CallRecordingPayload {
  transcript?: string;
  transcription_text?: string;
  text?: string;
  /** Some payload revisions nest it instead of flattening it. */
  transcription?: { text?: string };
}

/** An `agencyCalls` row, with only the fields this module reads. */
export interface CallRecord {
  id: string;
  telnyxCallId?: string | null;
  telnyxRecordingId?: string | null;
  recordingUrl?: string | null;
  fromNumber?: string | null;
  toNumber?: string | null;
  createdAt?: string | null;
  direction?: string | null;
  durationSeconds?: number | null;
  [key: string]: unknown;
}

export const CALL_RECORDING_SAVED = "call.recording.saved";
export const TRANSCRIPTION_SAVED = "call.recording.transcription.saved";
export const RECORDING_ERROR = "call.recording.error";

export const CALL_EVENT_TYPES: readonly string[] = [
  CALL_RECORDING_SAVED,
  TRANSCRIPTION_SAVED,
  RECORDING_ERROR,
];

/** True for a Telnyx event this module owns, so the route can route on one check. */
export function isCallEvent(eventType: string): boolean {
  return CALL_EVENT_TYPES.includes(eventType);
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
};

/** The call-control id, which is the id every call event is matched on. */
export function callIdOf(payload: CallRecordingPayload): string | undefined {
  return firstString(payload?.call_control_id, payload?.call_session_id);
}

/** The recording id, across the singular and array spellings Telnyx has used. */
export function recordingIdOf(payload: CallRecordingPayload): string | undefined {
  const list = payload?.recording_ids;
  return firstString(payload?.recording_id, Array.isArray(list) ? list[0] : undefined);
}

/** A playable recording URL. mp3 is preferred: it plays everywhere. */
export function recordingUrlOf(payload: CallRecordingPayload): string | undefined {
  const urls = payload?.recording_urls;
  return firstString(urls?.mp3, urls?.wav);
}

/** The transcript text, across every spelling this payload has used. */
export function transcriptOf(payload: TranscriptionPayload): string | undefined {
  return firstString(
    payload?.transcript,
    payload?.transcription_text,
    payload?.text,
    payload?.transcription?.text,
  );
}

/**
 * The patch for `call.recording.saved`.
 *
 * `transcriptionStatus` moves to PENDING because Telnyx will send a separate
 * transcription event; without it a row with a recording looks finished and the
 * transcript never gets attached.
 */
export function recordingPatch(payload: CallRecordingPayload): Record<string, unknown> {
  const patch: Record<string, unknown> = { transcriptionStatus: "PENDING" };
  const recordingId = recordingIdOf(payload);
  const url = recordingUrlOf(payload);
  if (recordingId) patch.telnyxRecordingId = recordingId;
  if (url) patch.recordingUrl = url;
  return patch;
}

/** The patch for `call.recording.transcription.saved`. */
export function transcriptionPatch(
  payload: TranscriptionPayload,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { transcriptionStatus: "READY" };
  const text = transcriptOf(payload);
  if (text) patch.transcript = text;
  return patch;
}

/**
 * The record to create when a recording arrives for a call we have no row for.
 *
 * `direction` is read from the event and defaults to UNKNOWN rather than being
 * assumed. Telnyx does not put it on every recording payload, and a wrong
 * direction is worse than an absent one: it silently mis-files the call in every
 * report filtered by it.
 */
export function newCallRecord(
  payload: CallRecordingPayload,
  now: Date,
): Record<string, unknown> {
  const from = payload?.from ?? "unknown";
  const stamp = now.toISOString().slice(0, 16).replace("T", " ");
  const record: Record<string, unknown> = {
    name: `INBOUND ${from} ${stamp}`,
    direction: firstString(payload?.direction) ?? "UNKNOWN",
    status: "COMPLETED",
    fromNumber: payload?.from ?? "",
    toNumber: payload?.to ?? "",
    telnyxCallId: callIdOf(payload) ?? "",
    transcriptionStatus: "PENDING",
  };
  const recordingId = recordingIdOf(payload);
  const url = recordingUrlOf(payload);
  if (recordingId) record.telnyxRecordingId = recordingId;
  if (url) record.recordingUrl = url;
  return record;
}

/** The row this call-control id already belongs to. */
export function findCallByTelnyxId<T extends CallRecord>(
  rows: readonly T[],
  telnyxCallId: string,
): T | null {
  return rows.find((row) => row.telnyxCallId === telnyxCallId) ?? null;
}

/** How long an unstamped row may still be waiting for its recording. */
export const ORPHAN_WINDOW_MS = 120 * 60_000;

/**
 * The row a recording belongs to when the call-control id was never stamped.
 *
 * A browser tab that closed between placing the call and saving the id leaves a
 * row with the right parties and no recording. Attaching to it is better than
 * creating a second row the operator will never connect to the first.
 *
 * Newest match wins, and only rows inside the window qualify, so an old
 * abandoned row cannot absorb a recording from a different call.
 */
export function findOrphanCall<T extends CallRecord>(
  rows: readonly T[],
  parties: { from?: string | undefined; to?: string | undefined },
  now: Date,
  windowMs: number = ORPHAN_WINDOW_MS,
): T | null {
  const { from, to } = parties;
  if (!from && !to) return null;
  const windowStart = now.getTime() - windowMs;
  let best: T | null = null;
  let bestAt = 0;
  for (const row of rows) {
    if (row.telnyxRecordingId || row.recordingUrl) continue;
    if (from && row.fromNumber && row.fromNumber !== from) continue;
    if (to && row.toNumber && row.toNumber !== to) continue;
    const at = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
    if (!Number.isFinite(at) || at < windowStart) continue;
    if (at > bestAt) {
      best = row;
      bestAt = at;
    }
  }
  return best;
}

/**
 * The patch that stores an AI analysis, plus the human summary.
 *
 * `summary` mirrors `aiSummary` so the row reads sensibly in Twenty's own record
 * list, which does not know about the ai* fields.
 */
export function analysisPatch(
  analysis: CallAnalysis,
  analyzedAt: Date,
): Record<string, unknown> {
  return {
    aiSummary: analysis.summary,
    aiSentiment: analysis.sentiment,
    aiScore: analysis.score,
    aiKeyPoints: JSON.stringify(analysis.keyPoints),
    aiScores: JSON.stringify(analysis.scores),
    aiConfidence: analysis.confidence,
    aiModel: analysis.model,
    aiAnalyzedAt: analyzedAt.toISOString(),
    summary: analysis.summary,
  };
}
