/**
 * The conversation state machine.
 *
 * One actor per enrollment. Inbound prospect messages flow
 * `awaiting_reply -> classifying -> routed -> <stable state>`, where `routed`
 * moves the machine's resolution into a path and each stable state recomputes
 * the reply gate on entry. The agent is never asked "may I reply" as a
 * separate call: `agentMayReply` in context is the answer, kept current by
 * the machine, and the send path reads it before calling `sendMessage`.
 *
 * Classification always sees the whole thread: the `classify` actor receives
 * every message collected so far, not just the latest one, so "ok sounds
 * good" resolves differently after an objection than after a greeting.
 * `opt_out` is sticky and suppression never reopens through this machine;
 * only an operator action outside it can do that.
 */

import { assign, fromPromise, setup } from "xstate";
import {
  canAgentRespond,
  classifyConversation,
  classifyMessageRules,
  latestConfidence,
  type ConversationClassification,
  type MessageClassification,
} from "./helpers/classify.ts";
import type {
  ClassifiedMessage,
  ConversationMessage,
  ConversationState,
  ResolutionPath,
} from "./types.ts";

/** Injectable classifier so tests and future Jev wiring share the machine. */
export type ClassifierFn = (text: string) => MessageClassification;

export interface ConversationMachineInput {
  enrollmentId: string;
  classifyOne?: ClassifierFn;
}

interface ConversationContext {
  enrollmentId: string;
  /** The whole thread, classified. The classifier rewrites this every turn. */
  messages: ClassifiedMessage[];
  conversationState: ConversationState;
  resolution: ResolutionPath;
  reason: string | null;
  /** Confidence of the latest inbound prospect message. */
  confidence: number;
  /** A human approved the current resolution. Sticky once set. */
  humanConfirmed: boolean;
  /** The gate, recomputed on entry to every stable state. */
  agentMayReply: boolean;
}

type ConversationEvent =
  | { type: "INBOUND"; message: ConversationMessage }
  | { type: "AGENT_REPLIED"; message: ConversationMessage }
  | { type: "RESOLVE"; path: ResolutionPath }
  | { type: "CONFIRM"; path: ResolutionPath }
  | { type: "CLOSE" }
  | { type: "MARK_DEAD" };

const STATE_FOR_RESOLUTION: Record<ResolutionPath, ConversationState> = {
  none: "awaiting_reply",
  answer: "engaged",
  qualify: "qualified",
  handle_objection: "handling_objection",
  rebook: "deferred",
  escalate: "needs_human",
  close: "resolved",
  suppress: "opted_out",
};

export function createConversationMachine(input: ConversationMachineInput) {
  const classifyOne = input.classifyOne ?? classifyMessageRules;

  return setup({
    types: {
      context: {} as ConversationContext,
      events: {} as ConversationEvent,
      input: {} as ConversationMachineInput,
    },
    actions: {
      queueInbound: assign(({ context, event }) => {
        if (event.type !== "INBOUND") return {};
        const pending: ClassifiedMessage = {
          ...event.message,
          state: "unknown",
          confidence: 0,
        };
        return { messages: [...context.messages, pending] };
      }),
      applyClassification: assign(({ event }) => {
        const output = (event as unknown as { output: ConversationClassification }).output;
        return {
          messages: output.messages,
          conversationState: output.conversationState,
          resolution: output.resolution,
          reason: output.reason,
          confidence: latestConfidence(output.messages),
        };
      }),
      classifyFailed: assign({
        conversationState: "needs_human",
        resolution: "escalate",
        reason: "Classification failed, so a human decides rather than the machine guessing.",
        confidence: 0,
        agentMayReply: false,
      } as Partial<ConversationContext>),
      recordAgentReply: assign(({ context, event }) => {
        if (event.type !== "AGENT_REPLIED") return {};
        const recorded: ClassifiedMessage = { ...event.message, state: "unknown", confidence: 1 };
        return { messages: [...context.messages, recorded] };
      }),
      applyManualResolution: assign(({ event }) => {
        if (event.type !== "RESOLVE") return {};
        return {
          resolution: event.path,
          conversationState: STATE_FOR_RESOLUTION[event.path],
          reason: `Operator moved the resolution to ${event.path}.`,
        };
      }),
      confirmHuman: assign(({ event }) => {
        if (event.type !== "CONFIRM") return {};
        return {
          humanConfirmed: true,
          resolution: event.path,
          conversationState: STATE_FOR_RESOLUTION[event.path],
          reason: `Human confirmed the ${event.path} resolution.`,
        };
      }),
      closeConversation: assign({
        conversationState: "resolved",
        resolution: "close",
        reason: "Operator closed the conversation.",
        agentMayReply: false,
      } as Partial<ConversationContext>),
      markDead: assign({
        conversationState: "dead",
        resolution: "none",
        reason: "Operator marked the conversation dead.",
        agentMayReply: false,
      } as Partial<ConversationContext>),
      refreshGate: assign(({ context }) => ({
        agentMayReply: canAgentRespond(
          context.conversationState,
          context.resolution,
          context.confidence,
          context.humanConfirmed,
        ),
      })),
    },
    guards: {
      isOptedOut: ({ context }) => context.conversationState === "opted_out",
      isSuppressed: ({ context }) => context.resolution === "suppress",
      isEscalated: ({ context }) => context.resolution === "escalate",
      resolvesClose: ({ context }) => context.resolution === "close",
      resolvesAnswer: ({ context }) => context.resolution === "answer",
      resolvesQualify: ({ context }) => context.resolution === "qualify",
      resolvesObjection: ({ context }) => context.resolution === "handle_objection",
      resolvesRebook: ({ context }) => context.resolution === "rebook",
    },
    actors: {
      classify: fromPromise(async ({ input: actorInput }: { input: { messages: ConversationMessage[] } }) =>
        classifyConversation(actorInput.messages, classifyOne),
      ),
    },
  }).createMachine({
    id: "conversation",
    version: "1",
    context: ({ input: machineInput }) => ({
      enrollmentId: machineInput.enrollmentId,
      messages: [],
      conversationState: "new",
      resolution: "none",
      reason: null,
      confidence: 0,
      humanConfirmed: false,
      agentMayReply: false,
    }),
    on: {
      RESOLVE: { target: ".routed", actions: "applyManualResolution" },
      CLOSE: { actions: "closeConversation", target: ".resolved" },
      MARK_DEAD: { actions: "markDead", target: ".dead" },
    },
    states: {
      new: {
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { target: "awaiting_reply", actions: "recordAgentReply" },
        },
      },
      classifying: {
        invoke: {
          src: "classify",
          input: ({ context }) => ({ messages: context.messages }),
          onDone: { target: "routed", actions: "applyClassification" },
          onError: { target: "needs_human", actions: "classifyFailed" },
        },
      },
      routed: {
        always: [
          { guard: "isOptedOut", target: "opted_out" },
          { guard: "isSuppressed", target: "opted_out" },
          { guard: "isEscalated", target: "needs_human" },
          { guard: "resolvesClose", target: "resolved" },
          { guard: "resolvesAnswer", target: "engaged" },
          { guard: "resolvesQualify", target: "qualified" },
          { guard: "resolvesObjection", target: "handling_objection" },
          { guard: "resolvesRebook", target: "deferred" },
          { target: "awaiting_reply" },
        ],
      },
      awaiting_reply: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { actions: "recordAgentReply" },
        },
      },
      engaged: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { target: "awaiting_reply", actions: "recordAgentReply" },
        },
      },
      handling_objection: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { target: "awaiting_reply", actions: "recordAgentReply" },
        },
      },
      qualified: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { target: "awaiting_reply", actions: "recordAgentReply" },
        },
      },
      deferred: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          AGENT_REPLIED: { target: "awaiting_reply", actions: "recordAgentReply" },
        },
      },
      needs_human: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
          CONFIRM: { target: "routed", actions: "confirmHuman" },
        },
      },
      resolved: {
        entry: "refreshGate",
        on: {
          INBOUND: { target: "classifying", actions: "queueInbound" },
        },
      },
      opted_out: {
        entry: "refreshGate",
        on: {
          // Sticky suppression: the trail still records the message, but the
          // state never leaves opted_out through this machine.
          INBOUND: { actions: "queueInbound" },
        },
      },
      dead: {
        entry: "refreshGate",
        on: {
          INBOUND: { actions: "queueInbound" },
        },
      },
    },
  });
}

export type ConversationMachine = ReturnType<typeof createConversationMachine>;
