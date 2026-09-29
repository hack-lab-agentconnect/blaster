/**
 * Message classification and confidence-gated resolution.
 *
 * Two classifiers share one result shape so they are interchangeable:
 *
 *   - `classifyMessageRules` is the deterministic baseline. It runs with no
 *     key, no network, and no model, which makes it the classifier the tests
 *     and the machine's default input use. Its confidence never reaches the
 *     auto-act ceiling, so a rules-only deployment answers and qualifies but
 *     never books or closes without a human-readable trail.
 *   - `buildJevQuestions` produces the TypeSafe request for Jev (see
 *     `docs/typesafe/primitives/choice.md`): one call, three questions
 *     (`message_state`, `requested_resolution`, `tone`) evaluated in parallel
 *     against the whole transcript as state. It returns plain data rather
 *     than calling the API, because external I/O stays in clients and Convex
 *     actions, never in pure helpers. Wire it to `@typesafe-ai/sdk`
 *     `client.systemOne` once `TYPESAFE_API_KEY` is set; the answers drop
 *     straight into `ClassifiedMessage` plus `gateResolution`.
 *
 * `opt_out` is matched by rules first and always wins: suppression is a
 * compliance action, never a model judgment call.
 */

import type {
  ClassifiedMessage,
  ConversationMessage,
  ConversationState,
  MessageState,
  ResolutionPath,
} from "../types.ts";

export interface MessageClassification {
  state: MessageState;
  confidence: number;
}

export interface ConversationClassification {
  messages: ClassifiedMessage[];
  conversationState: ConversationState;
  resolution: ResolutionPath;
  /** Why this resolution was chosen, in words, for the operator trail. */
  reason: string;
}

/** Below this confidence the code escalates instead of acting. */
export const CONFIDENCE_FLOOR = 0.6;
/** Booking or closing takes this confidence or a human confirm. */
export const HIGH_STAKES_THRESHOLD = 0.85;
/** The highest confidence the rule baseline may claim. */
export const RULES_CONFIDENCE_CEILING = 0.8;

const OPT_OUT_PATTERNS = [
  /\bstop\b/,
  /\bunsubscribe\b/,
  /\bremove me\b/,
  /\bdo not (contact|call|text|message)\b/,
  /\bdon'?t (contact|call|text|message) me\b/,
  /\btake me off/,
  /\bno more (texts|messages|calls)\b/,
  /\bopt ?out\b/,
];

const POSITIVE_PATTERNS = [
  /\b(sounds good|that works|let'?s do it|i'?m interested|interested)\b/,
  /\b(book|schedule|sign ?up|call me|yes|yeah|yep|sure|ok\b)/,
  /\bwhat'?s next\b/,
  /\btell me more\b/,
];

const OBJECTION_PATTERNS = [
  // Pushback language only. A bare price mention ("how much does it cost",
  // "what is your pricing") is a question that wants an answer, not an
  // objection, so price words alone never match here.
  /\b(too expensive|costs? too much|can'?t afford|too much|too (high|steep|pricey))\b/,
  /\bnot interested\b/,
  /\balready have (a|an|someone)\b/,
  /\b(why should i|convince me|what'?s the catch)\b/,
  /\b(bad (time|reviews)|scam|spam)\b/,
];

const DEFERRAL_PATTERNS = [
  /\b(later|not now|busy|call (me )?back|next week|tomorrow|monday)\b/,
  /\b(can you (call|text) (me )?(later|tomorrow|next week))\b/,
  /\b(get back to|follow up (later|tomorrow))\b/,
];

const QUESTION_HINT = /\?|\b(who|what|when|where|why|how|which|can you|do you|is there|are you)\b/;

const GREETING_PATTERNS = [/^(hi|hey|hello|yo|morning|afternoon|evening)\b/];

/**
 * Classify one message with deterministic rules.
 *
 * Order matters: opt-out is checked before anything that could succeed, so a
 * suppression can never be downgraded into an objection or a question.
 */
export function classifyMessageRules(text: string): MessageClassification {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return { state: "unknown", confidence: 0 };

  if (OPT_OUT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { state: "opt_out", confidence: 1 };
  }
  if (OBJECTION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { state: "objection", confidence: RULES_CONFIDENCE_CEILING };
  }
  if (DEFERRAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { state: "deferral", confidence: RULES_CONFIDENCE_CEILING };
  }
  if (POSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { state: "positive", confidence: RULES_CONFIDENCE_CEILING };
  }
  if (QUESTION_HINT.test(normalized)) {
    return { state: "question", confidence: 0.7 };
  }
  if (GREETING_PATTERNS.some((pattern) => pattern.test(normalized)) && normalized.length < 30) {
    return { state: "greeting", confidence: 0.7 };
  }
  return { state: "unknown", confidence: 0 };
}

/** Render the whole thread as transcript state for the classifier. */
export function renderTranscript(messages: ConversationMessage[]): string {
  return messages
    .map((message) => `${message.role === "prospect" ? "prospect" : "agent"}: ${message.text}`)
    .join("\n");
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface JevRequest {
  state: string;
  questions: {
    message_state: JevChoiceQuestion;
    requested_resolution: JevChoiceQuestion;
    tone: JevChoiceQuestion;
  };
}

/**
 * Build the Jev request for the latest prospect message.
 *
 * The state is the entire conversation, not the single message, because the
 * fifth "ok sounds good" means something different after an objection than
 * after a greeting. Follows the multi-question single-call shape in
 * `docs/typesafe/primitives/choice.md`; `other` catch-alls are included so
 * the model can say none of the options fit instead of forcing one.
 */
export function buildJevQuestions(
  messages: ConversationMessage[],
  targetId: string,
): JevRequest {
  const target = messages.find((message) => message.id === targetId);
  const targetLine = target ? `classify this message: "${target.text}"` : "classify the latest prospect message";
  return {
    state: `${renderTranscript(messages)}\n---\n${targetLine}`,
    questions: {
      message_state: {
        type: "choice",
        instructions: "What is the prospect doing in the target message?",
        criteria: {
          greeting: "A hello or opener with no content beyond acknowledging contact",
          question: "Asking for information about the service price timing or process",
          positive: "Expressing interest agreement or readiness to move forward",
          objection: "Pushing back on price need timing trust or relevance",
          deferral: "Asking to talk later rather than now",
          opt_out: "Asking to stop all contact such as stop unsubscribe or do not contact me",
          irrelevant: "A message unrelated to the outreach such as a wrong number or gibberish",
          other: "None of the above fits",
        },
      },
      requested_resolution: {
        type: "choice",
        instructions: "What should happen next in this conversation?",
        criteria: {
          answer: "Reply with a direct answer to their question",
          qualify: "Ask a qualifying question to move toward a booking",
          handle_objection: "Address their concern about price need timing or trust",
          rebook: "Agree a later time to talk",
          escalate: "Hand to a human because the intent is unclear or the tone needs care",
          close: "Wrap up because the outcome is decided",
          suppress: "Stop messaging entirely because they opted out",
        },
      },
      tone: {
        type: "choice",
        instructions: "What is the prospect's tone?",
        criteria: { calm: null, frustrated: null, angry: null },
      },
    },
  };
}

const STATE_FOR_MESSAGE: Record<MessageState, ConversationState> = {
  greeting: "engaged",
  question: "engaged",
  positive: "qualified",
  objection: "handling_objection",
  deferral: "deferred",
  opt_out: "opted_out",
  irrelevant: "engaged",
  unknown: "needs_human",
};

const RESOLUTION_FOR_MESSAGE: Record<MessageState, ResolutionPath> = {
  greeting: "qualify",
  question: "answer",
  positive: "qualify",
  objection: "handle_objection",
  deferral: "rebook",
  opt_out: "suppress",
  irrelevant: "answer",
  unknown: "escalate",
};

/**
 * Classify the whole conversation and gate the resolution on confidence.
 *
 * `classifyOne` defaults to the rule baseline; pass the Jev-backed function
 * once it exists and the aggregation below does not change. Only inbound
 * prospect messages are classified; agent turns are context.
 *
 * The gate follows `docs/typesafe/patterns/confidence-routing.md`: below the
 * floor the code escalates instead of acting, and an `opt_out` suppresses
 * regardless of confidence because it was matched deterministically.
 */
export function classifyConversation(
  messages: ConversationMessage[],
  classifyOne: (text: string) => MessageClassification = classifyMessageRules,
): ConversationClassification {
  const classified: ClassifiedMessage[] = messages.map((message) =>
    message.role === "prospect"
      ? { ...message, ...classifyOne(message.text) }
      : { ...message, state: "unknown" as MessageState, confidence: 1 },
  );

  const inbound = classified.filter((message) => message.role === "prospect");
  if (inbound.length === 0) {
    return {
      messages: classified,
      conversationState: "awaiting_reply",
      resolution: "none",
      reason: "No inbound message yet, so there is nothing to classify.",
    };
  }

  const latest = inbound[inbound.length - 1] as ClassifiedMessage;

  if (latest.state === "opt_out") {
    return {
      messages: classified,
      conversationState: "opted_out",
      resolution: "suppress",
      reason: "Opt-out matched deterministically, so messaging stops without model review.",
    };
  }

  if (latest.confidence < CONFIDENCE_FLOOR) {
    return {
      messages: classified,
      conversationState: "needs_human",
      resolution: "escalate",
      reason: `Latest message confidence ${latest.confidence.toFixed(2)} is below the ${CONFIDENCE_FLOOR} floor, so a human decides.`,
    };
  }

  // A prior opt-out is sticky: once suppressed, later messages cannot reopen
  // the thread through classification alone.
  if (inbound.some((message) => message.state === "opt_out")) {
    return {
      messages: classified,
      conversationState: "opted_out",
      resolution: "suppress",
      reason: "An earlier message opted out, so the thread stays suppressed.",
    };
  }

  return {
    messages: classified,
    conversationState: STATE_FOR_MESSAGE[latest.state],
    resolution: RESOLUTION_FOR_MESSAGE[latest.state],
    reason: `Latest message is ${latest.state} at confidence ${latest.confidence.toFixed(2)}.`,
  };
}

/**
 * Whether the agent may answer right now.
 * The gate is deliberately boring: a respondable state, a non-terminal
 * resolution, and confidence at or above the floor. Booking and closing are
 * high-stakes resolutions, so they additionally need `HIGH_STAKES_THRESHOLD`
 * or an explicit human confirm carried in `humanConfirmed`.
 */
export function canAgentRespond(
  conversationState: ConversationState,
  resolution: ResolutionPath,
  confidence: number,
  humanConfirmed = false,
): boolean {
  if (
    conversationState !== "engaged" &&
    conversationState !== "handling_objection" &&
    conversationState !== "qualified" &&
    conversationState !== "deferred"
  ) {
    return false;
  }
  if (resolution === "none" || resolution === "escalate" || resolution === "suppress") {
    return false;
  }
  if (confidence < CONFIDENCE_FLOOR) return false;
  if (resolution === "close" && confidence < HIGH_STAKES_THRESHOLD && !humanConfirmed) {
    return false;
  }
  return true;
}

/** Confidence of the latest inbound prospect message, or 0 when none exists. */
export function latestConfidence(messages: ClassifiedMessage[]): number {
  const inbound = messages.filter((message) => message.role === "prospect");
  return inbound.length > 0 ? (inbound[inbound.length - 1] as ClassifiedMessage).confidence : 0;
}
