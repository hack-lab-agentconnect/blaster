/**
 * The Blaster API, as one client.
 *
 * This is the contract the terminal client, the CLI, and MCP all speak. The
 * three surfaces previously had no shared read path at all, which is how they
 * drift: each would format the same conversation differently and no test would
 * notice. Here they call the same functions and therefore return the same
 * payload, and a change to the shape breaks all three at once.
 *
 * The token is the operator's own, minted by `blaster login`, so the client
 * works from anywhere the operator is signed in and needs no separate
 * credential of its own.
 */

export type CampaignGroup = "unassigned" | "multiple" | "one";

/** One row in the inbox, exactly as `/api/conversations` returns it. */
export interface ConversationSummary {
  id: string;
  /** The other party, E.164. */
  phoneNumber: string;
  /** The Blaster number we reached them from, E.164. */
  blasterNumber: string;
  latestMessageAt: number;
  latestDirection: "inbound" | "outbound" | null;
  latestPreview: string | null;
  messageCount: number;
  latestMessageId: string | null;
  /** Present only when the campaign was requested. */
  campaignId?: string | null;
  sequenceId?: string | null;
  campaignGroup?: CampaignGroup;
  candidateCampaignIds?: string[];
}

/** One stored message, exactly as `/api/conversations/:id/messages` returns it. */
export interface ConversationMessageRow {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  from: string;
  to: string;
  status: string;
  telnyxMessageId: string | null;
  sentAt: number;
  media: Array<{ url: string; contentType?: string; size?: number }> | null;
}

export interface ListConversationsQuery {
  limit?: number;
  /** Only threads for this sending number, E.164. */
  number?: string;
  /** Only threads in this campaign. Resolves the campaign, so it costs more. */
  campaign?: string;
  withCampaign?: boolean;
}

/** What the provider said about a message we just handed it. */
export interface SentMessage {
  id: string;
  /**
   * The state the provider reported for the recipient, e.g. `queued` at
   * acceptance. Delivery arrives later on the webhook, not in this response.
   */
  status: string;
  from: string;
  to: string;
  profileId: string | null;
}

/** A send request. The profile is never part of it: the API reads it. */
export interface SendRequest {
  to: string;
  text: string;
  /** Omit to let the API use the workspace's only number. */
  from?: string;
}

/** How the sending number's profile was chosen, echoed for the operator. */
export interface SendResolution {
  profileId: string | null;
  /**
   * Always `bound-to-number` for a send: the profile came from the sending
   * number's own record in Twenty, never from a global default.
   */
  reason: string;
  country: string | null;
  warning?: string;
}

/**
 * A workspace sending number the operator may send from, exactly as
 * `GET /api/agency-phones` returns it.
 *
 * The id is the Twenty record id: the server re-resolves it to the row on
 * every use, so a client can never smuggle a number or a profile past the
 * workspace's own records. Only rows that can actually send are listed.
 */
export interface SendingNumber {
  agencyPhoneId: string;
  phoneNumber: string;
  label: string;
  countryCode?: string | null;
}

/**
 * One filterable prospect field, exactly as `GET /api/prospects/fields`
 * returns it. Names are Twenty field API names, never display labels, and
 * `filterOperators` is the complete menu: anything else is a 400, so a
 * client cannot submit arbitrary Twenty query DSL.
 */
export interface ProspectField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  filterOperators: string[];
}

/** One filter clause. Values arrive as strings from the CLI and are coerced server-side. */
export interface ProspectFilter {
  field: string;
  operator: string;
  value?: string | string[] | boolean | number;
}

/** One prospect row, exactly as search and preview return it. */
export interface ProspectSummary {
  id: string;
  name: string;
  phone: string | null;
  country: string | null;
  campaign: string | null;
}

/** One page of a prospect search. */
export interface ProspectSelection {
  total: number;
  prospects: ProspectSummary[];
  nextCursor: string | null;
}

/** What a batch would do, without sending anything. */
export interface SendPreview {
  total: number;
  eligible: number;
  skipped: number;
  sample: ProspectSummary[];
}

/** One recipient's outcome inside a batch. Never a bare boolean. */
export interface RecipientOutcome {
  prospectId: string;
  phone: string | null;
  status: "sent" | "skipped" | "failed";
  detail?: string | null;
  telnyxId?: string | null;
}

/** The whole of a batch send: every recipient accounted for. */
export interface BatchSendResult {
  agencyPhoneId: string;
  from: string;
  idempotencyKey: string;
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  outcomes: RecipientOutcome[];
}

/**
 * A failure the caller can act on. `unauthorized` is separated from the rest
 * because it has exactly one remedy: sign in again.
 */
export class BlasterApiError extends Error {
  readonly status: number;
  readonly kind: "unauthorized" | "unavailable" | "not-found" | "server" | "malformed";

  constructor(status: number, kind: BlasterApiError["kind"], message: string) {
    super(message);
    this.name = "BlasterApiError";
    this.status = status;
    this.kind = kind;
  }
}

export function classifyStatus(status: number): BlasterApiError["kind"] {
  if (status === 401) return "unauthorized";
  if (status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  if (status === 503) return "unavailable";
  if (status >= 500) return "server";
  return "malformed";
}
