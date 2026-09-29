/**
 * Conversation classification types.
 *
 * Every message in a thread gets one `MessageState`; the thread itself holds
 * one `ConversationState`. The per-message label is what the classifier
 * produces (rule baseline today, Jev `choice` when `TYPESAFE_API_KEY` is set);
 * the conversation state is what the machine moves through, and the
 * `ResolutionPath` is how a classified conversation gets resolved into
 * something the agent is allowed to act on.
 *
 * The question shapes in `helpers/classify.ts` follow
 * `docs/typesafe/primitives/choice.md` (one request, several questions,
 * criteria maps with an `other` catch-all) and the gating thresholds follow
 * `docs/typesafe/patterns/confidence-routing.md` (a confidence floor below
 * which the code escalates instead of acting).
 */

export type MessageRole = "prospect" | "agent";

/** One SMS in a thread, as the classifier needs to see it. */
export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  sentAt: number;
}

/**
 * What one prospect message is.
 *
 * `opt_out` is terminal and safety-critical, so it is checked by deterministic
 * rules before any model output is trusted. `unknown` means neither the rules
 * nor the model could place the message, and it always escalates.
 */
export type MessageState =
  | "greeting"
  | "question"
  | "positive"
  | "objection"
  | "deferral"
  | "opt_out"
  | "irrelevant"
  | "unknown";

/** A message with its classification attached. */
export interface ClassifiedMessage extends ConversationMessage {
  state: MessageState;
  /** 0 to 1. Below the gate floor the conversation escalates. */
  confidence: number;
}

/**
 * Where the whole conversation stands.
 *
 * `new` and `awaiting_reply` are pre-reply states: nothing inbound has been
 * classified yet. The `engaged` family is where the agent may respond.
 * `needs_human`, `opted_out`, `dead`, and `resolved` are terminal for the
 * agent: the gate refuses a reply there no matter what the model suggests.
 */
export type ConversationState =
  | "new"
  | "awaiting_reply"
  | "engaged"
  | "handling_objection"
  | "qualified"
  | "deferred"
  | "needs_human"
  | "resolved"
  | "opted_out"
  | "dead";

/**
 * How a classified conversation gets resolved.
 *
 * A resolution is a path, not a reply: it names the next motion
 * (`answer`, `qualify`, `handle_objection`, `rebook`) or the exit
 * (`escalate`, `close`, `suppress`). The agent reply is generated only after
 * a path is chosen and the gate approves it.
 */
export type ResolutionPath =
  | "none"
  | "answer"
  | "qualify"
  | "handle_objection"
  | "rebook"
  | "escalate"
  | "close"
  | "suppress";

export const MESSAGE_STATES: readonly MessageState[] = [
  "greeting",
  "question",
  "positive",
  "objection",
  "deferral",
  "opt_out",
  "irrelevant",
  "unknown",
] as const;

/** States in which the agent is allowed to answer. */
export const RESPONDABLE_STATES: readonly ConversationState[] = [
  "engaged",
  "handling_objection",
  "qualified",
  "deferred",
] as const;
