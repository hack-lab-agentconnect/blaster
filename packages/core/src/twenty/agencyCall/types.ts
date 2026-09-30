/**
 * The `agencyCalls` object, as this module names and provisions it.
 *
 * A mirror, not a repo-owned name: `agencyCall` is Twenty's own `nameSingular`
 * for this object, so the directory keeps Twenty's spelling. See
 * docs/naming-conventions.md, "the external system wins".
 */

import type { CallRecord, CallRecordingPayload, TranscriptionPayload } from "./helpers/index.ts";

export type { CallRecord, CallRecordingPayload, TranscriptionPayload };

/** The shape of a provisioned field, for reporting what a run changed. */
export type CallFieldKind = "text" | "date-time" | "number" | "relation";

export interface CallFieldReport {
  name: string;
  kind: CallFieldKind;
  /** False when the field was already there, which is the normal case on a re-run. */
  isNew: boolean;
}

export interface SetupCallHistoryOptions {
  /** The Twenty base URL, e.g. https://twenty.example.com */
  baseUrl: string;
  /**
   * An OAuth bearer for the metadata endpoint. The workspace API key does not
   * work here — `/metadata` answers it "Missing authentication token" — so this
   * is deliberately a different credential from the one record writes use.
   */
  token: string;
  /** The auth-guard credentials, when the instance sits behind one. */
  basicAuth?: { user: string; password: string } | null;
  /** Page size for the object listing. A workspace holds far fewer than this. */
  first?: number;
}

export interface CallSchemaResult {
  objectId: string;
  objectIsNew: boolean;
  fields: CallFieldReport[];
}
