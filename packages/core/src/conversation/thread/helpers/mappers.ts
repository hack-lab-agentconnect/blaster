/**
 * Mapping between thread storage and the classifier.
 *
 * The classifier reasons over `ConversationMessage` (`prospect`/`agent` with
 * plain text). These mappers are the only place that knows the thread stores
 * `user`/`assistant` with string-or-parts content: everything downstream
 * keeps speaking the classifier's shape.
 */

import type { ConversationMessage } from "../../classification/types.ts";
import type { ThreadContentPart, ThreadStoredMessage } from "../types.ts";

/** Normalise string-or-parts content to plain text. Non-text parts are dropped. */
export function extractText(content: string | ThreadContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join(" ");
}

/**
 * Thread messages in, classifier messages out.
 *
 * `system` and `tool` turns are context for the model but not utterances to
 * classify, so they are dropped here. They remain in the thread itself.
 */
export function toConversationMessages(thread: readonly ThreadStoredMessage[]): ConversationMessage[] {
  return thread.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    return [
      {
        id: message.id,
        role: message.role === "user" ? "prospect" : "agent",
        text: extractText(message.content),
        sentAt: message.sentAt,
      } satisfies ConversationMessage,
    ];
  });
}
