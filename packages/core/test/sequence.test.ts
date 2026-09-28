import { describe, expect, test } from "vitest";
import { PROFILES } from "../src/telnyx/messaging/helpers/profile.ts";
import {
  DEFAULT_OPTIONS,
  advance,
  dueAtForStep,
  evaluateEligibility,
  stepText,
  summarise,
  validateDraft,
  type Enrollment,
  type SequenceDraft,
  type SequenceStepDraft,
} from "../src/pipeline/sequence/helpers/builder.ts";

const US = "+14155552671";
const IE = "+353871234567";
const GB = "+447400123456";
const DE = "+4915112345678";

const env = {
  [PROFILES.default]: "profile-default",
  [PROFILES.us]: "profile-us-10dlc",
  [PROFILES.ie]: "profile-ie-alpha",
};

function draft(overrides: Partial<SequenceDraft> = {}): SequenceDraft {
  return {
    name: "Spring outreach",
    fromNumber: IE,
    options: { ...DEFAULT_OPTIONS },
    steps: [
      { text: "First message", delayHours: 0, isStop: false },
      { text: "Follow up", delayHours: 48, isStop: false },
    ],
    ...overrides,
  };
}

describe("validateDraft", () => {
  test("a well-formed draft has no problems", () => {
    expect(validateDraft(draft())).toEqual([]);
  });

  test("name and number are required", () => {
    const problems = validateDraft(draft({ name: "  ", fromNumber: "not-a-number" }));
    expect(problems.map((p) => p.field)).toEqual(expect.arrayContaining(["name", "fromNumber"]));
  });

  test("a sequence needs at least one step", () => {
    expect(validateDraft(draft({ steps: [] }))).toEqual([
      { field: "steps", problem: "A sequence needs at least one step." },
    ]);
  });

  test("a sending step needs a body, but a stop step does not", () => {
    const problems = validateDraft(
      draft({ steps: [{ text: "   ", delayHours: 0, isStop: false }] }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("steps[0]");

    const stopOnly = validateDraft(draft({ steps: [{ text: "", delayHours: 0, isStop: true }] }));
    expect(stopOnly).toEqual([]);
  });

  test("the first sending step must be immediate", () => {
    const problems = validateDraft(
      draft({ steps: [{ text: "hi", delayHours: 24, isStop: false }] }),
    );
    expect(problems.map((p) => p.field)).toContain("steps[0].delayHours");
  });

  test("a negative delay is rejected", () => {
    const problems = validateDraft(
      draft({
        steps: [
          { text: "hi", delayHours: 0, isStop: false },
          { text: "again", delayHours: -1, isStop: false },
        ],
      }),
    );
    expect(problems.map((p) => p.field)).toContain("steps[1].delayHours");
  });

  test("a daily cap must be a whole number or zero", () => {
    const problems = validateDraft(
      draft({ options: { ...DEFAULT_OPTIONS, dailyCapPerRecipient: 1.5 } }),
    );
    expect(problems.map((p) => p.field)).toContain("options.dailyCapPerRecipient");
  });

  test("every problem is returned at once, not one per call", () => {
    const problems = validateDraft(draft({ name: "", fromNumber: "x", steps: [] }));
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("evaluateEligibility", () => {
  const options = { ...DEFAULT_OPTIONS };

  test("an ordinary recipient with a registered country is eligible", () => {
    const verdict = evaluateEligibility(env, options, { id: "1", to: IE, country: "IE" });
    expect(verdict.eligible).toBe(true);
    expect(verdict.profile?.profileId).toBe("profile-ie-alpha");
  });

  test("US and GB both resolve, each to the registration they need", () => {
    // GB is covered by the IE profile rather than having one of its own: both
    // need an alphanumeric sender, so one registration serves them.
    const us = evaluateEligibility(env, options, { id: "1", to: US, country: "US" });
    const gb = evaluateEligibility(env, options, { id: "2", to: GB, country: "GB" });
    expect(us.profile?.profileId).toBe("profile-us-10dlc");
    expect(gb.profile?.profileId).toBe("profile-ie-alpha");
    expect(us.eligible).toBe(true);
    expect(gb.eligible).toBe(true);
  });

  test("do-not-contact outranks everything, including a valid profile", () => {
    const verdict = evaluateEligibility(env, options, {
      id: "1",
      to: IE,
      country: "IE",
      doNotContact: true,
    });
    expect(verdict.reason).toBe("do-not-contact");
  });

  test("a reply stops the sequence when stopOnReply is on", () => {
    const verdict = evaluateEligibility(env, options, { id: "1", to: IE, hasReplied: true });
    expect(verdict.reason).toBe("already-replied");
  });

  test("a reply is ignored when the operator turned stopping off", () => {
    const verdict = evaluateEligibility(
      env,
      { ...options, stopOnReply: false },
      { id: "1", to: IE, hasReplied: true },
    );
    expect(verdict.eligible).toBe(true);
  });

  test("a country with no profile is skipped, not sent from the default", () => {
    // DE is deliberately uncovered here. GB is not a good subject for this
    // test, because the IE profile is registered for both IE and GB: they share
    // an alphanumeric sender, so GB is covered whenever IE is.
    const verdict = evaluateEligibility(env, options, { id: "1", to: DE, country: "DE" });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe("no-profile-for-country");
    expect(verdict.detail).toContain("DE");
  });

  test("the same country is sent when the operator accepts the default", () => {
    const verdict = evaluateEligibility(
      env,
      { ...options, requireProfileForCountry: false },
      { id: "1", to: DE, country: "DE" },
    );
    expect(verdict.eligible).toBe(true);
    expect(verdict.profile?.profileId).toBe("profile-default");
  });

  test("no phone number means no send", () => {
    expect(evaluateEligibility(env, options, { id: "1", to: null }).reason).toBe("no-number");
  });

  test("the daily cap is enforced once reached", () => {
    const capped = { ...options, dailyCapPerRecipient: 2 };
    const under = evaluateEligibility(env, capped, { id: "1", to: IE, sentInLastDay: 1 });
    const over = evaluateEligibility(env, capped, { id: "1", to: IE, sentInLastDay: 2 });
    expect(under.eligible).toBe(true);
    expect(over.reason).toBe("daily-cap-reached");
  });

  test("a cap of zero means no cap", () => {
    const verdict = evaluateEligibility(env, options, { id: "1", to: IE, sentInLastDay: 99 });
    expect(verdict.eligible).toBe(true);
  });

  test("no configured profile at all blocks the send", () => {
    const verdict = evaluateEligibility({}, options, { id: "1", to: IE });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reason).toBe("no-profile-for-country");
  });
});

describe("scheduling", () => {
  const steps: SequenceStepDraft[] = [
    { text: "one", delayHours: 0, isStop: false },
    { text: "two", delayHours: 48, isStop: false },
    { text: "three", delayHours: 96, isStop: false },
  ];

  test("a step is due relative to the start of the sequence", () => {
    const start = 1_000_000;
    expect(dueAtForStep(steps, 0, start)).toBe(start);
    expect(dueAtForStep(steps, 1, start)).toBe(start + 48 * 3_600_000);
  });

  test("a cursor past the end has no due time", () => {
    expect(dueAtForStep(steps, 3, 0)).toBeNull();
  });

  const active: Enrollment = {
    id: "e1",
    sequenceId: "s1",
    recipientId: "r1",
    cursor: 0,
    status: "active",
    enrolledAt: 0,
    nextDueAt: 0,
    lastSentAt: null,
  };

  test("a send advances the cursor and schedules the next step from the send time", () => {
    const next = advance(steps, active, 5_000);
    expect(next.cursor).toBe(1);
    expect(next.status).toBe("active");
    expect(next.nextDueAt).toBe(5_000 + 48 * 3_600_000);
    expect(next.lastSentAt).toBe(5_000);
  });

  test("the final step completes the enrollment", () => {
    const last = { ...active, cursor: 2 };
    const next = advance(steps, last, 1_000);
    expect(next.status).toBe("completed");
    expect(next.nextDueAt).toBeNull();
  });

  test("a stop step ends the sequence without sending", () => {
    const withStop: SequenceStepDraft[] = [
      { text: "one", delayHours: 0, isStop: false },
      { text: "", delayHours: 72, isStop: true },
    ];
    const next = advance(withStop, active, 1_000);
    expect(next.status).toBe("completed");
    expect(next.nextDueAt).toBeNull();
  });

  test("stepText returns nothing for a stop step", () => {
    expect(stepText(steps, 0)).toBe("one");
    expect(stepText([{ text: "", delayHours: 0, isStop: true }], 0)).toBeNull();
  });
});

describe("summarise", () => {
  test("counts sending steps and the span they cover", () => {
    const result = summarise(
      draft({
        steps: [
          { text: "one", delayHours: 0, isStop: false },
          { text: "two", delayHours: 24, isStop: false },
          { text: "", delayHours: 48, isStop: true },
        ],
      }),
    );
    expect(result).toEqual({
      steps: 3,
      sendingSteps: 2,
      stopStep: true,
      spanHours: 24,
      firstStepHours: 0,
      lastStepHours: 24,
    });
  });
});
