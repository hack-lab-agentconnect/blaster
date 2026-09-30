/**
 * Twenty `agencyCalls`: the call-history record.
 *
 * A mirror of the object, so the directory keeps Twenty's spelling. See
 * docs/naming-conventions.md, "the external system wins".
 *
 * The entry point holds the I/O and the wiring; the field list and the
 * event-to-patch mapping are pure and live in `helpers/`, and the schema
 * provisioning that creates this object lives in `schema.ts` so it can never run
 * from a webhook.
 *
 * Every function here tolerates a workspace where `agencyCalls` has not been
 * provisioned. A missing object is a configuration state, not a failure, and the
 * webhook that calls this has a two-second acknowledgement budget: answering 500
 * because a workspace lacks an optional object would burn Telnyx's retries on an
 * event that was never going to succeed.
 */

import type { WriteActor } from "../actor/types.ts";
import type { TwentyClient, TwentyRecord } from "../client/index.ts";
import { analyzeCallTranscript, isAiConfigured } from "../../ai/analysis/index.ts";
import type { CallAnalysis } from "../../ai/analysis/types.ts";
import {
  CALL_EVENT_TYPES,
  RECORDING_ERROR,
  TRANSCRIPTION_SAVED,
  analysisPatch,
  callIdOf,
  findCallByTelnyxId,
  findOrphanCall,
  isCallEvent,
  newCallRecord,
  recordingPatch,
  transcriptionPatch,
  type CallRecord,
  type CallRecordingPayload,
  type TranscriptionPayload,
} from "./helpers/index.ts";
import { CALLS_OBJECT_PLURAL } from "./helpers/schema.ts";

export * from "./helpers/index.ts";
export type {
  CallFieldKind,
  CallFieldReport,
  CallRecord,
  CallRecordingPayload,
  CallSchemaResult,
  SetupCallHistoryOptions,
  TranscriptionPayload,
} from "./types.ts";
export { setupCallHistorySchema } from "./schema.ts";

/** What a call event did to the record, for the webhook's response. */
export type CallEventOutcome =
  | "attached"
  | "attached-to-open-row"
  | "created"
  | "transcript-attached"
  | "transcript-attached-to-open-row"
  | "marked-failed"
  | "no-matching-call"
  | "unusable-event"
  | "object-not-provisioned";

export interface CallEventResult {
  outcome: CallEventOutcome;
  callId: string | null;
  detail: string;
}

/** True when the object is absent rather than the request being wrong. */
function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "TwentyError" && error.message.includes("Twenty 404");
}

/** Every call row, or nothing when the object has not been provisioned. */
export async function listCalls(client: TwentyClient): Promise<CallRecord[]> {
  try {
    return await client.listAll<TwentyRecord>(CALLS_OBJECT_PLURAL);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function findCallById(client: TwentyClient, telnyxCallId: string): Promise<CallRecord | null> {
  return findCallByTelnyxId(await listCalls(client), telnyxCallId);
}

/**
 * The row a call event belongs to, from a single read of the object.
 *
 * Both matchers run against the same rows on purpose. The webhook has a
 * two-second acknowledgement budget and `listCalls` walks every page, so asking
 * twice is two network round-trips spent before the write even starts. The
 * fallback is only consulted when the id lookup misses, and it reads the same
 * snapshot either way.
 */
function matchCall(
  rows: CallRecord[],
  payload: CallRecordingPayload,
  now: Date,
): { row: CallRecord; byParties: boolean } | null {
  const callControlId = callIdOf(payload);
  const byId = callControlId ? findCallByTelnyxId(rows, callControlId) : null;
  if (byId) return { row: byId, byParties: false };
  const orphan = findOrphanCall(rows, { from: payload.from, to: payload.to }, now);
  return orphan ? { row: orphan, byParties: true } : null;
}

/**
 * Attach a recording to the call it belongs to.
 *
 * Three cases, in order of preference: the row already carries this call-control
 * id, the row was left unstamped by a tab that closed (matched on parties and
 * recency), or there is no row at all and one is created. Creating rather than
 * attaching is the last resort precisely because a duplicate row is worse than a
 * missing one — an operator reading history cannot tell them apart.
 */
async function attachRecording(
  client: TwentyClient,
  payload: CallRecordingPayload,
  actor: WriteActor | null | undefined,
  now: Date,
): Promise<CallEventResult> {
  const callControlId = callIdOf(payload);
  if (!callControlId) return { outcome: "unusable-event", callId: null, detail: "no call_control_id" };

  const match = matchCall(await listCalls(client), payload, now);
  if (match) {
    await client.update(
      CALLS_OBJECT_PLURAL,
      match.row.id,
      match.byParties
        ? { ...recordingPatch(payload), telnyxCallId: callControlId }
        : recordingPatch(payload),
      actor,
    );
    return match.byParties
      ? {
          outcome: "attached-to-open-row",
          callId: match.row.id,
          detail: `attached to unstamped row ${match.row.id}`,
        }
      : { outcome: "attached", callId: match.row.id, detail: `attached to ${match.row.id}` };
  }

  const created = await client.create(
    CALLS_OBJECT_PLURAL,
    newCallRecord(payload, now),
    actor,
  );
  return created
    ? { outcome: "created", callId: created.id, detail: `created ${created.id}` }
    : { outcome: "created", callId: null, detail: "created but Twenty returned no record" };
}

/** Attach a transcript, then kick off AI analysis when one is configured. */
async function attachTranscript(
  client: TwentyClient,
  payload: TranscriptionPayload,
  actor: WriteActor | null | undefined,
  now: Date,
): Promise<CallEventResult> {
  const callControlId = callIdOf(payload);
  if (!callControlId) return { outcome: "unusable-event", callId: null, detail: "no call_control_id" };

  const target = matchCall(await listCalls(client), payload, now);
  if (!target) {
    return { outcome: "no-matching-call", callId: null, detail: "no call row for this call_control_id" };
  }

  const patch = transcriptionPatch(payload);
  // Stamp the id on the way through, so the next event for this call matches
  // directly instead of re-running the parties fallback.
  if (!target.row.telnyxCallId) patch.telnyxCallId = callControlId;
  await client.update(CALLS_OBJECT_PLURAL, target.row.id, patch, actor);

  // Not awaited: the transcription is stored, and Telnyx must not wait on an LLM
  // to answer. A failure inside is swallowed by storeAnalysis, because the
  // transcript is already saved and the call is usable without the grading.
  const transcript = typeof patch.transcript === "string" ? patch.transcript : undefined;
  if (transcript) void storeAnalysis(client, target.row.id, transcript, actor, now);

  return {
    outcome: target.byParties ? "transcript-attached-to-open-row" : "transcript-attached",
    callId: target.row.id,
    detail: `transcript attached to ${target.row.id}`,
  };
}

async function markTranscriptionFailed(
  client: TwentyClient,
  payload: CallRecordingPayload,
  actor: WriteActor | null | undefined,
): Promise<CallEventResult> {
  const callControlId = callIdOf(payload);
  if (!callControlId) return { outcome: "unusable-event", callId: null, detail: "no call_control_id" };
  const existing = await findCallById(client, callControlId);
  if (!existing) {
    return { outcome: "no-matching-call", callId: null, detail: "no call row for this call_control_id" };
  }
  await client.update(
    CALLS_OBJECT_PLURAL,
    existing.id,
    { transcriptionStatus: "FAILED" },
    actor,
  );
  return { outcome: "marked-failed", callId: existing.id, detail: `marked ${existing.id} failed` };
}

/**
 * Analyse a transcript and store the result on the call.
 *
 * Failures are swallowed on purpose: an analysis is an enrichment, and a provider
 * outage must not turn a successfully recorded call into a failed webhook. The
 * transcript is already stored by the time this runs.
 */
export async function storeAnalysis(
  client: TwentyClient,
  callId: string,
  transcript: string,
  actor?: WriteActor | null,
  now: Date = new Date(),
): Promise<CallAnalysis | null> {
  if (!isAiConfigured()) return null;
  const call = await client.get<TwentyRecord>(CALLS_OBJECT_PLURAL, callId);
  try {
    const analysis = await analyzeCallTranscript(transcript, {
      direction: typeof call?.direction === "string" ? call.direction : null,
      durationSeconds:
        typeof call?.durationSeconds === "number" ? call.durationSeconds : null,
    });
    await client.update(CALLS_OBJECT_PLURAL, callId, analysisPatch(analysis, now), actor);
    return analysis;
  } catch {
    return null;
  }
}

/**
 * Apply one Telnyx call event to the call history.
 *
 * Returns an outcome rather than throwing for the cases that are not the
 * caller's fault (a missing object, an event with no id, no matching row), so
 * the webhook can answer 2xx and stop Telnyx retrying something unfixable.
 */
export async function handleCallEvent(
  client: TwentyClient,
  eventType: string,
  payload: CallRecordingPayload | TranscriptionPayload,
  options: { actor?: WriteActor | null; now?: Date } = {},
): Promise<CallEventResult> {
  if (!isCallEvent(eventType)) {
    return { outcome: "unusable-event", callId: null, detail: `${eventType} is not a call event` };
  }
  const now = options.now ?? new Date();
  const actor = options.actor ?? null;
  try {
    if (eventType === TRANSCRIPTION_SAVED) {
      return await attachTranscript(client, payload as TranscriptionPayload, actor, now);
    }
    if (eventType === RECORDING_ERROR) {
      return await markTranscriptionFailed(client, payload, actor);
    }
    return await attachRecording(client, payload, actor, now);
  } catch (error) {
    if (isNotFound(error)) {
      return {
        outcome: "object-not-provisioned",
        callId: null,
        detail: "agencyCalls is not provisioned in this workspace",
      };
    }
    throw error;
  }
}

export { CALL_EVENT_TYPES };
