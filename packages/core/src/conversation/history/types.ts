/**
 * Conversation history: the durable record of what was actually said.
 *
 * A Telnyx message id identifies one message, not a relationship. The stable
 * identity here is the *pair*: the recipient and the Blaster number that
 * reached them. Keying on that pair is what makes "show me the conversation
 * with this number" dependable across restarts, number reassignments, and
 * provider retries.
 *
 * This module is the pure half: normalization, the pair key, and the mapping
 * from a verified Telnyx event to a stored message. No Convex, no fetch, so it
 * is testable and it is the single place the wire format is interpreted.
 */

export type MessageDirection = "inbound" | "outbound";

/** Telnyx delivery states, collapsed to what the UI and CLI actually show. */
export type MessageStatus =
  | "received"
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "unknown";

export interface StoredMessage {
  conversationId?: string;
  direction: MessageDirection;
  body: string;
  /** E.164, normalized. */
  from: string;
  to: string;
  status: MessageStatus;
  /** Telnyx message id. Unique per message, not per conversation. */
  telnyxMessageId: string | null;
  /** Telnyx webhook event id. The dedupe key: Telnyx retries, and a retry is
   * the same event, not a new message. */
  providerEventId: string | null;
  sentAt: number;
  /** MMS attachments, when the message had them. */
  media?: Array<{ url: string; contentType?: string; size?: number }>;
}

/** The subset of a conversation the list view needs. */
export interface StoredConversationSummary {
  id: string;
  /** The Blaster number that reached them. */
  blasterNumber: string;
  /** The other party, in E.164. */
  phoneNumber: string;
  latestMessageAt: number;
  latestDirection: MessageDirection | null;
  latestPreview: string | null;
  messageCount: number;
}

/** An inbound message, reduced from a verified Telnyx event. */
export interface InboundMessageInput {
  telnyxMessageId: string | null;
  providerEventId: string | null;
  from: string;
  to: string;
  body: string;
  receivedAt: number;
  media?: Array<{ url: string; contentType?: string; size?: number }>;
}
