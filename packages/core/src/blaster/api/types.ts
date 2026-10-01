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
 * One filter operator, as the field menu and every prompt expose it.
 * `token` is the DSL term sent to Twenty; `label` and `hint` are the human
 * words the prompts render instead of the bare token. This is the typed,
 * normalized operator set: the CLI, the API, and any later function all read
 * these from the shared registry rather than spelling tokens by hand.
 */
export interface ProspectOperator {
  /** The DSL token, e.g. `eq` in `field[eq]:"value"`. */
  token: string;
  /** What the operator is, in plain words, for a prompt. */
  label: string;
  /** What a value means, in plain words, for a prompt. */
  hint: string;
}

/**
 * One filterable prospect field, exactly as `GET /api/prospects/fields`
 * returns it. Names are Twenty field API names, never display labels, and
 * `filterOperators` is the complete menu (DSL tokens): anything else is a
 * 400, so a client cannot submit arbitrary Twenty query DSL.
 * `operatorLabels` is the human word for each token, in the same order, so
 * a prompt shows "equals" instead of "eq" without a second source of truth.
 * It is optional: a server deployed before this field existed omits it, and
 * a prompt must fall back to the token rather than assume it is present.
 */
export interface ProspectField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  filterOperators: string[];
  operatorLabels?: string[];
}

/**
 * One filter clause. Values arrive as strings from the CLI and are coerced
 * server-side. The operator is a DSL token from the shared registry
 * (`eq`, `like`, ...), validated against the field's allowed set.
 */
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

/** One pool of sending numbers, as `/api/pools` returns it. */
export interface PoolSummary {
  id: string;
  name: string;
  status: "active" | "paused";
  strategy: string;
  /** The `order` of the member most recently used. */
  cursor: number;
  minSpacingMs: number;
  dailyCapPerNumber: number;
  /** How many members can currently send. */
  activeNumberCount: number;
  /** Earliest instant the pool could next send. */
  nextAvailableAt: number;
  lastDispatchedAt: number | null;
  createdAt: number;
}

/** One number's membership in a pool, with its live rate state. */
export interface PoolNumberRow {
  phoneNumberId: string;
  phoneNumber: string;
  order: number;
  status: "active" | "paused" | "removed";
  sentToday: number;
  nextAvailableAt: number;
  lastSentAt: number | null;
  assignedAt: number;
  removedAt: number | null;
}

/** A pool with its memberships, as `/api/pools/:id` returns it. */
export interface PoolDetail extends PoolSummary {
  numbers: PoolNumberRow[];
}

export interface CreatePoolInput {
  name: string;
  minSpacingMs?: number;
  dailyCapPerNumber?: number;
}

export interface AddPoolNumberInput {
  poolId: string;
  phoneNumber: string;
  order?: number;
}

export interface RemovePoolNumberInput {
  poolId: string;
  phoneNumber: string;
}

export interface ReorderPoolNumbersInput {
  poolId: string;
  /** E.164 numbers, in the order the pool should work them. */
  order: string[];
}

export interface SetSequencePoolInput {
  sequenceId: string;
  /** Omit to clear the assignment and fall back to the fixed `fromNumber`. */
  poolId?: string;
}

/** A sequence, as `/api/sequences` returns it, for a pool-assignment picker. */
export interface SequenceOption {
  id: string;
  name: string;
  status: string;
  /** The pool already assigned, when there is one. */
  poolId: string | null;
}

/** One durable per-person suppression, as `/api/suppressions` returns it. */
export interface SuppressionRow {
  peer: string;
  reason?: string;
  source: "inbound-opt-out" | "manual";
  createdAt: number;
}

/** One prospect's outcome inside an enroll run. Never a bare boolean. */
export interface EnrollOutcome {
  prospectId: string;
  phone: string | null;
  status: "enrolled" | "skipped";
  detail: string | null;
}

/** The whole of an enroll run: every prospect accounted for. */
export interface EnrollResult {
  total: number;
  enrolled: number;
  skipped: number;
  outcomes: EnrollOutcome[];
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
