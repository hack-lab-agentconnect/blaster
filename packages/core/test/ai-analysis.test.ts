import { describe, expect, test, vi } from "vitest";
import {
  aiConfig,
  analyzeCallTranscript,
  clamp,
  extractJson,
  isAiConfigured,
  normalizeKeyPoints,
  normalizeSentiment,
  score15,
} from "../src/ai/analysis/index.ts";

const ENV = { OPENAI_API_KEY: "sk-test" };

/** A chat-completions response carrying whatever the model "said". */
function completion(content: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("normalisation", () => {
  test("sentiment is constrained to the enum, case-insensitively", () => {
    expect(normalizeSentiment("positive")).toBe("POSITIVE");
    expect(normalizeSentiment(" MIXED ")).toBe("MIXED");
    // An invented sentiment must not reach the enum.
    expect(normalizeSentiment("VERY_POSITIVE")).toBe("NEUTRAL");
    expect(normalizeSentiment(undefined)).toBe("NEUTRAL");
  });

  test("numbers arrive as strings and out of range, and are coerced", () => {
    expect(clamp("82", 0, 100, 50)).toBe(82);
    expect(clamp(900, 0, 100, 50)).toBe(100);
    expect(clamp(-5, 0, 100, 50)).toBe(0);
    expect(clamp("nonsense", 0, 100, 50)).toBe(50);
    expect(clamp(null, 0, 100, 50)).toBe(50);
  });

  test("the overall score maps onto the 1-5 sub-score scale", () => {
    expect(score15(100)).toBe(5);
    expect(score15(50)).toBe(3);
    expect(score15(0)).toBe(1);
  });

  test("key points are capped at five and stripped of blanks", () => {
    expect(normalizeKeyPoints(["a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(normalizeKeyPoints(["1", "2", "3", "4", "5", "6"])).toHaveLength(5);
    expect(normalizeKeyPoints("not an array")).toEqual([]);
  });

  test("JSON is recovered from a fence, from prose, and from both", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('Here you go: {"a":1} hope that helps')).toBe('{"a":1}');
    // No braces at all: returned untouched so the parse error names the real fault.
    expect(extractJson("not json")).toBe("not json");
  });
});

describe("configuration", () => {
  test("defaults are the documented ones", () => {
    const config = aiConfig({ OPENAI_API_KEY: "sk-test" });
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.model).toBe("gpt-4o-mini");
  });

  test("a gateway and a different model are both overridable", () => {
    const config = aiConfig({ ...ENV, OPENAI_BASE_URL: "https://llm.local/v1/", OPENAI_ANALYSIS_MODEL: "local-7b" });
    expect(config.baseUrl).toBe("https://llm.local/v1");
    expect(config.model).toBe("local-7b");
  });

  test("configured is exactly a key being present", () => {
    expect(isAiConfigured(ENV)).toBe(true);
    expect(isAiConfigured({})).toBe(false);
  });
});

describe("analyzeCallTranscript", () => {
  test("refuses without a key rather than calling an unauthenticated endpoint", async () => {
    const fetchFn = vi.fn();
    await expect(
      analyzeCallTranscript("a long enough transcript", undefined, {
        env: {},
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("refuses a transcript too short to be a call", async () => {
    await expect(
      analyzeCallTranscript("hi", undefined, { env: ENV, fetchFn: vi.fn() as unknown as typeof fetch }),
    ).rejects.toThrow(/too short/i);
  });

  test("a well-formed answer is used as-is", async () => {
    const analysis = await analyzeCallTranscript(
      "agent: how are you? prospect: fine, thanks.",
      { direction: "INBOUND", durationSeconds: 42 },
      {
        env: ENV,
        fetchFn: (async () =>
          completion({
            summary: "Short but polite.",
            sentiment: "POSITIVE",
            score: 78,
            scores: { conversion: 4, politeness: 5, questioning: 3, engagement: 4, sentiment: 5 },
            keyPoints: ["Asked about pricing"],
            confidence: 0.7,
          })) as unknown as typeof fetch,
      },
    );
    expect(analysis.sentiment).toBe("POSITIVE");
    expect(analysis.score).toBe(78);
    expect(analysis.scores.politeness).toBe(5);
    expect(analysis.model).toBe("gpt-4o-mini");
  });

  test("a fenced response is unwrapped rather than rejected", async () => {
    const analysis = await analyzeCallTranscript("a transcript long enough to analyse", undefined, {
      env: ENV,
      fetchFn: (async () =>
        completion('```json\n{"summary":"ok","sentiment":"NEUTRAL","score":50}\n```')) as unknown as typeof fetch,
    });
    expect(analysis.summary).toBe("ok");
  });

  test("missing sub-scores fall back to the overall score, not a flat 3", async () => {
    const analysis = await analyzeCallTranscript("a transcript long enough to analyse", undefined, {
      env: ENV,
      fetchFn: (async () =>
        completion({ summary: "ok", score: 90 })) as unknown as typeof fetch,
    });
    // 90/20 rounds to 5 on the 1-5 scale.
    expect(analysis.scores.conversion).toBe(5);
    expect(analysis.scores.sentiment).toBe(5);
  });

  test("an empty summary gets a placeholder rather than a blank record", async () => {
    const analysis = await analyzeCallTranscript("a transcript long enough to analyse", undefined, {
      env: ENV,
      fetchFn: (async () => completion({ summary: "   " })) as unknown as typeof fetch,
    });
    expect(analysis.summary).toBe("No summary returned.");
  });

  test("a provider error is surfaced, not silently treated as no analysis", async () => {
    await expect(
      analyzeCallTranscript("a transcript long enough to analyse", undefined, {
        env: ENV,
        fetchFn: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/429/);
  });

  test("a non-JSON answer is an error, because there is nothing to normalise", async () => {
    await expect(
      analyzeCallTranscript("a transcript long enough to analyse", undefined, {
        env: ENV,
        fetchFn: (async () => completion("I cannot help with that.")) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not JSON/);
  });

  test("a very long transcript is truncated before it is sent", async () => {
    let sent = "";
    await analyzeCallTranscript("x".repeat(20_000), undefined, {
      env: ENV,
      fetchFn: (async (_url: string, init?: RequestInit) => {
        sent = String(init?.body ?? "");
        return completion({ summary: "ok" });
      }) as unknown as typeof fetch,
    });
    expect(sent.length).toBeLessThan(20_000);
  });
});
