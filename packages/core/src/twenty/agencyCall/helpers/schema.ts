/**
 * The `agencyCalls` field set, and the two pure helpers schema setup needs.
 *
 * The list mirrors exactly what the call-history write path sends and reads, so a
 * field cannot be written without being declared here.
 */

/** The object this module owns, in both the singular and plural spelling. */
export const CALLS_OBJECT_SINGULAR = "agencyCall";
export const CALLS_OBJECT_PLURAL = "agencyCalls";

/**
 * Free-form text.
 *
 * Status-like values are TEXT rather than a SELECT (`IN_PROGRESS`, `NO_ANSWER`,
 * `PENDING`, `READY`, `FAILED`) because the set differs per call flow and a
 * closed enum would mean a migration every time a new terminal state appears.
 * `aiSentiment` is TEXT for the same reason.
 */
export const TEXT_FIELDS: readonly string[] = [
  "name",
  "direction",
  "status",
  "fromNumber",
  "toNumber",
  "telnyxCallId",
  "telnyxRecordingId",
  "recordingUrl",
  "transcript",
  "transcriptionStatus",
  "summary",
  "debugLog",
  "meetingUrl",
  "meetingProvider",
  "meetingBookingId",
  "meetingStatus",
  "createdByMemberId",
  // AI analysis. One row is one call, so the rating lives on the record rather
  // than in a side table. aiSentiment is POSITIVE/NEUTRAL/NEGATIVE/MIXED and
  // aiKeyPoints/aiScores are JSON strings.
  "aiSummary",
  "aiSentiment",
  "aiKeyPoints",
  "aiScores",
  "aiModel",
];

export const DATE_TIME_FIELDS: readonly string[] = [
  "startedAt",
  "endedAt",
  "meetingAt",
  "aiAnalyzedAt",
];

export const NUMBER_FIELDS: readonly string[] = [
  "durationSeconds",
  "aiScore",
  "aiConfidence",
];

/**
 * Relations to other `agency*` objects, and why they are not TEXT fields.
 *
 * A Twenty relation is declared under its *base* name with type RELATION
 * (`agencyPhone`); the REST write surface then addresses it as `agencyPhoneId`.
 * Declaring a TEXT field literally named `agencyPhoneId` would shadow the
 * relation with a useless column holding an id string: no join, no cascade, and
 * nothing for the UI to render as a link. So these are created as relations only.
 */
export const RELATION_FIELDS: readonly { name: string; target: string }[] = [
  { name: "agencyPhone", target: "agencyPhone" },
  { name: "agencyProspect", target: "agencyProspect" },
  { name: "agencyLead", target: "agencyLead" },
];

/** The column REST writes use for a relation declared under `name`. */
export const relationJoinColumn = (name: string): string => `${name}Id`;

/** `telnyxCallId` becomes "Telnyx Call ID": acronym-aware, unlike a naive split. */
export function labelFor(name: string): string {
  return name
    .replace(/Id$/, " ID")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

/**
 * Whether a metadata failure means "this field is already there".
 *
 * Twenty phrases the same collision two different ways depending on whether the
 * name or the label collided, and a setup routine that only matches one of them
 * throws on the second run of an otherwise idempotent migration.
 */
export function isFieldExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /already exists|already used by another field/i.test(message);
}
