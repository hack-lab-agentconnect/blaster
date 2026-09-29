/**
 * The structured context the model reasons over.
 *
 * One JSON-serializable shape built from the enrollment row, the thread, the
 * latest classification, and the selected guidance entry. It is passed as
 * system context on generation calls, so the model sees the same structured
 * state the deterministic code sees: no second representation of the
 * conversation is ever constructed for the model.
 */

import type {
  ConversationMessage,
  ConversationState,
  ResolutionPath,
} from "../../classification/types.ts";

export interface AgentContextEnrollment {
  sequenceId: string;
  recipientId: string;
  to?: string;
  country?: string;
  status: string;
  cursor: number;
  conversationState?: ConversationState;
  resolutionPath?: ResolutionPath;
}

export interface AgentContextClassification {
  conversationState: ConversationState;
  resolution: ResolutionPath;
  confidence: number;
  reason: string;
}

export interface AgentContext {
  enrollment: AgentContextEnrollment;
  thread: ConversationMessage[];
  classification?: AgentContextClassification;
  /** Guidance text for the resolved path, from `selectGuidance`. */
  guidance?: string;
  voice: string;
}

export const VOICE_RULES =
  "lowercase only, never any capitals, never any commas, never fully punctually correct; short casual texts";

/** Assemble the model context from pieces the callers already hold. */
export function buildAgentContext(args: {
  enrollment: AgentContextEnrollment;
  thread: ConversationMessage[];
  classification?: AgentContextClassification;
  guidance?: string;
}): AgentContext {
  return {
    enrollment: args.enrollment,
    thread: args.thread,
    classification: args.classification,
    guidance: args.guidance,
    voice: VOICE_RULES,
  };
}
