import { describe, expect, test } from "vitest";
import {
  buildJevQuestions,
  canAgentRespond,
  classifyConversation,
  classifyMessageRules,
  renderTranscript,
} from "../src/conversation/classification/helpers/classify.ts";
import {
  formatAgentReply,
  obeysVoice,
} from "../src/conversation/classification/helpers/style.ts";
import type { ConversationMessage } from "../src/conversation/classification/types.ts";

function inbound(id: string, text: string, sentAt = 1): ConversationMessage {
  return { id, role: "prospect", text, sentAt };
}

function agent(id: string, text: string, sentAt = 0): ConversationMessage {
  return { id, role: "agent", text, sentAt };
}

describe("classifyMessageRules", () => {
  test("opt-out wins over everything, including questions", () => {
    expect(classifyMessageRules("how much does it cost? actually stop texting me").state).toBe("opt_out");
    expect(classifyMessageRules("STOP").state).toBe("opt_out");
    expect(classifyMessageRules("please do not contact me again").state).toBe("opt_out");
  });

  test("objections, deferrals, positives, and questions", () => {
    expect(classifyMessageRules("thats too expensive for us").state).toBe("objection");
    expect(classifyMessageRules("we already have someone for that").state).toBe("objection");
    expect(classifyMessageRules("call me back next week im busy").state).toBe("deferral");
    expect(classifyMessageRules("sounds good lets do it").state).toBe("positive");
    expect(classifyMessageRules("how much does it cost").state).toBe("question");
    expect(classifyMessageRules("hi").state).toBe("greeting");
  });

  test("gibberish is unknown with zero confidence", () => {
    const result = classifyMessageRules("xjz qvp wobble");
    expect(result.state).toBe("unknown");
    expect(result.confidence).toBe(0);
  });
});

describe("classifyConversation", () => {
  test("an empty thread waits for a reply with no resolution", () => {
    const result = classifyConversation([]);
    expect(result.conversationState).toBe("awaiting_reply");
    expect(result.resolution).toBe("none");
  });

  test("the whole thread is classified, not just the latest message", () => {
    const result = classifyConversation([
      agent("a1", "hey its sam from pipeworks, got a sec"),
      inbound("p1", "how much for a full repipe"),
      inbound("p2", "ok sounds good, what is next"),
    ]);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[1]?.state).toBe("question");
    expect(result.messages[2]?.state).toBe("positive");
    expect(result.conversationState).toBe("qualified");
    expect(result.resolution).toBe("qualify");
  });

  test("low confidence escalates instead of guessing", () => {
    const result = classifyConversation([inbound("p1", "xjz qvp wobble")]);
    expect(result.conversationState).toBe("needs_human");
    expect(result.resolution).toBe("escalate");
  });

  test("an earlier opt-out keeps the thread suppressed", () => {
    const result = classifyConversation([inbound("p1", "stop"), inbound("p2", "actually tell me more")]);
    expect(result.conversationState).toBe("opted_out");
    expect(result.resolution).toBe("suppress");
  });
});

describe("canAgentRespond", () => {
  test("terminal and escalated states refuse a reply", () => {
    expect(canAgentRespond("opted_out", "suppress", 1)).toBe(false);
    expect(canAgentRespond("needs_human", "escalate", 0.9)).toBe(false);
    expect(canAgentRespond("resolved", "close", 1)).toBe(false);
    expect(canAgentRespond("awaiting_reply", "none", 1)).toBe(false);
  });

  test("engaged states allow a reply above the floor", () => {
    expect(canAgentRespond("engaged", "answer", 0.7)).toBe(true);
    expect(canAgentRespond("handling_objection", "handle_objection", 0.6)).toBe(true);
    expect(canAgentRespond("engaged", "answer", 0.59)).toBe(false);
  });

  test("closing needs high confidence or a human confirm", () => {
    expect(canAgentRespond("qualified", "close", 0.8)).toBe(false);
    expect(canAgentRespond("qualified", "close", 0.85)).toBe(true);
    expect(canAgentRespond("qualified", "close", 0.7, true)).toBe(true);
  });
});

describe("buildJevQuestions", () => {
  test("one request carries the transcript as state plus three questions", () => {
    const messages = [agent("a1", "hey got a sec"), inbound("p1", "how much")];
    const request = buildJevQuestions(messages, "p1");
    expect(request.state).toContain("prospect: how much");
    expect(request.state).toContain("agent: hey got a sec");
    expect(Object.keys(request.questions)).toEqual(["message_state", "requested_resolution", "tone"]);
    expect(request.questions.message_state.type).toBe("choice");
    expect(request.questions.message_state.criteria.other).toBeDefined();
  });

  test("transcript order is preserved", () => {
    const lines = renderTranscript([agent("a1", "one"), inbound("p1", "two")]).split("\n");
    expect(lines).toEqual(["agent: one", "prospect: two"]);
  });
});

describe("formatAgentReply", () => {
  test("lowercases, drops commas, and singles punctuation", () => {
    expect(formatAgentReply("Hey, totally get it! What is your timeline?")).toBe(
      "hey totally get it! what is your timeline?",
    );
  });

  test("strips semicolons, colons, and quotes", () => {
    expect(formatAgentReply('She said: "call; me later"')).toBe("she said call me later");
  });

  test("collapses whitespace and trims", () => {
    expect(formatAgentReply("  hey   hows it   going  ")).toBe("hey hows it going");
  });

  test("obeysVoice accepts styled output and rejects the rest", () => {
    expect(obeysVoice(formatAgentReply("Yes, I Can Help!"))).toBe(true);
    expect(obeysVoice("Hey, how are you?")).toBe(false);
    expect(obeysVoice("HEY THERE")).toBe(false);
    expect(obeysVoice("really??")).toBe(false);
  });
});
