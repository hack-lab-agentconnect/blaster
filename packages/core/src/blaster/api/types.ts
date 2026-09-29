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
