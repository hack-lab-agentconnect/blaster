/**
 * Thread message shapes.
 *
 * Deliberately component-agnostic: core never imports `@convex-dev/agent`,
 * so these stay portable and testable. The Convex boundary (`convex/threads.ts`)
 * narrows the component's `MessageDoc` into `ThreadStoredMessage` on the way
 * in and widens back on the way out.
 */

export type ThreadRole = "user" | "assistant" | "system" | "tool";

export type ThreadContentPart = {
  type: string;
  text?: string;
};

/** One message as stored in an agent thread, as core needs to see it. */
export interface ThreadStoredMessage {
  id: string;
  role: ThreadRole;
  /** Plain string or AI-SDK content parts; `extractText` normalises both. */
  content: string | ThreadContentPart[];
  sentAt: number;
  /** Telnyx provider id, carried in message metadata at the boundary. */
  providerMessageId?: string;
  direction?: "inbound" | "outbound";
  /** Sequence step this outbound message fulfilled, when known. */
  step?: number;
}
