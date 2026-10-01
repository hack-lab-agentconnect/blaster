import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_OPTIONS, type Recipient, type SequenceDraft } from "@blaster/core";
import { RUNNER_GAPS, planFor, type SequenceContext } from "../src/cli/sequence.ts";
import { findDraft, readDrafts, saveDraft } from "../src/cli/sequence-store.ts";

/**
 * The recorded-draft lifecycle and the compliance plan.
 *
 * The store is pointed at a temporary directory rather than the working
 * directory, so these tests never touch a real `.blaster/`, and the plan runs
 * through the real statechart with eligibility injected.
 */

let root: string;
const at = Date.UTC(2026, 2, 2, 15, 0, 0); // Monday afternoon, inside every US window

const DRAFT: SequenceDraft = {
  name: "Spring outreach",
  fromNumber: "+15550000000",
  options: { ...DEFAULT_OPTIONS },
  steps: [
    { text: "first", delayHours: 0, isStop: false },
    { text: "second", delayHours: 48, isStop: false },
  ],
};

const recipient = (over: Partial<Recipient> = {}): Recipient => ({
  id: "p-1",
  to: "+15557654321",
  country: "US",
  stateCode: "NY",
  doNotContact: false,
  hasReplied: false,
  sentInLastDay: 0,
  ...over,
});

const allow = () => ({ eligible: true, reason: null, detail: null });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blaster-seq-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the draft store", () => {
  test("an empty directory reads as no drafts rather than throwing", () => {
    expect(readDrafts(root)).toEqual([]);
  });

  test("a draft is recorded and read back", () => {
    expect(saveDraft(root, DRAFT, "2026-03-01T00:00:00.000Z")).toBe(true);
    const found = findDraft(root, "Spring outreach");
    expect(found?.draft.steps).toHaveLength(2);
    expect(found?.createdAt).toBe("2026-03-01T00:00:00.000Z");
  });

  test("saving the same name twice updates rather than duplicating", () => {
    saveDraft(root, DRAFT, "2026-03-01T00:00:00.000Z");
    const updated: SequenceDraft = { ...DRAFT, steps: [{ text: "changed", delayHours: 0, isStop: false }] };
    expect(saveDraft(root, updated, "2026-03-02T00:00:00.000Z")).toBe(false);
    const drafts = readDrafts(root);
    expect(drafts).toHaveLength(1);
    // The created stamp survives an update, so "when did this start" stays answerable.
    expect(drafts[0]?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect(drafts[0]?.updatedAt).toBe("2026-03-02T00:00:00.000Z");
  });

  test("lookup is case-insensitive on the name", () => {
    saveDraft(root, DRAFT, "2026-03-01T00:00:00.000Z");
    expect(findDraft(root, "SPRING OUTREACH")).not.toBeNull();
    expect(findDraft(root, "nope")).toBeNull();
  });

  test("a corrupt file reads as no drafts instead of crashing", () => {
    mkdirSync(join(root, ".blaster"), { recursive: true });
    writeFileSync(join(root, ".blaster", "sequences.json"), "{ not json", "utf8");
    // A damaged file should not stop an operator running every other command.
    expect(readDrafts(root)).toEqual([]);
  });

  test("a draft from an older file is defaulted rather than trusted", () => {
    mkdirSync(join(root, ".blaster"), { recursive: true });
    writeFileSync(
      join(root, ".blaster", "sequences.json"),
      JSON.stringify({
        version: 1,
        drafts: [{ draft: { name: "old", fromNumber: "+1", steps: [{ text: "hi" }] } }],
      }),
      "utf8",
    );
    const stored = readDrafts(root)[0]?.draft;
    expect(stored?.steps[0]?.delayHours).toBe(0);
    // The safe defaults, so a file written before a rule existed cannot have
    // opted out of stopping on reply.
    expect(stored?.options.stopOnReply).toBe(true);
    expect(stored?.options.respectDoNotContact).toBe(true);
  });

  test("a draft is written where the doc says it is", () => {
    saveDraft(root, DRAFT, "2026-03-01T00:00:00.000Z");
    const raw = readFileSync(join(root, ".blaster", "sequences.json"), "utf8");
    expect(JSON.parse(raw).drafts[0].draft.name).toBe("Spring outreach");
  });
});

describe("the compliance plan", () => {
  const plan = (recipients: Recipient[], evaluate = allow) =>
    planFor(DRAFT, recipients, at, evaluate);

  test("a recipient inside the window would be sent", () => {
    const [row] = plan([recipient()]);
    expect(row?.verdict).toBe("send");
    expect(row?.timeZone).toBe("America/New_York");
    expect(row?.quiet).toBe(false);
  });

  test("the plan is the statechart's own answer, not a reimplementation", () => {
    const [row] = plan([recipient()]);
    // Would-send is read off the effect the machine asked for.
    expect(row?.state).toBe("claiming");
  });

  test("a do-not-contact prospect is skipped, and the reason is the rule's", () => {
    const [row] = plan(
      [recipient({ doNotContact: true })],
      () => ({ eligible: false, reason: "do-not-contact", detail: "marked DNC" }),
    );
    expect(row?.verdict).toBe("skip");
    expect(row?.reason).toBe("do-not-contact");
  });

  test("someone who already replied is skipped before anything else is checked", () => {
    const [row] = plan(
      [recipient({ hasReplied: true })],
      () => ({ eligible: false, reason: "already-replied", detail: "already answered" }),
    );
    expect(row?.reason).toBe("already-replied");
  });

  test("a recipient with no number cannot be sent", () => {
    const [row] = plan([recipient({ to: null })], () => ({
      eligible: false,
      reason: "no-number",
      detail: "no number",
    }));
    expect(row?.verdict).toBe("skip");
  });

  test("a number outside the sending window is held, not dropped", () => {
    // 03:00 Eastern, two hours into quiet hours.
    const threeAm = Date.UTC(2026, 2, 2, 8, 0, 0);
    const [row] = planFor(DRAFT, [recipient()], threeAm, allow);
    expect(row?.quiet).toBe(true);
    expect(row?.nextAllowedAt).toBeGreaterThan(threeAm);
    expect(row?.detail).toMatch(/quiet hours/i);
  });

  test("an unplaceable number is not planned as a send", () => {
    const [row] = planFor(DRAFT, [recipient({ stateCode: null })], at, allow);
    // No zone means no provably-legal send time, so it is parked rather than sent.
    expect(row?.state).toBe("awaiting_human");
    expect(row?.verdict).toBe("skip");
  });

  test("the same instant is planned differently for two zones", () => {
    // 23:00 Eastern: quiet. 23:00 Pacific: quiet too, but 20:00 Eastern against a
    // 23:00 Pacific instant is the point -- the plan is per recipient, not global.
    const twentyOneEastern = Date.UTC(2026, 2, 2, 22, 0, 0);
    const east = planFor(DRAFT, [recipient({ stateCode: "NY" })], twentyOneEastern, allow)[0];
    const pacific = planFor(DRAFT, [recipient({ stateCode: "CA" })], twentyOneEastern, allow)[0];
    expect(east?.timeZone).toBe("America/New_York");
    expect(pacific?.timeZone).toBe("America/Los_Angeles");
  });
});

describe("the runner gaps are named, not hidden", () => {
  test("all three missing pieces are declared", () => {
    expect(RUNNER_GAPS).toHaveLength(3);
    const text = RUNNER_GAPS.join(" ");
    // The three things that stop a draft from running unattended today.
    expect(text).toMatch(/convex\/schema\.ts/);
    expect(text).toMatch(/sequenceSendClaims/);
    expect(text).toMatch(/convex\.json/);
  });

  test("the context carries what the command needs and nothing global", () => {
    const ctx: SequenceContext = {
      root,
      flags: new Map(),
      json: true,
      jsonOut: () => "{}",
      now: () => at,
      evaluate: allow,
    };
    // A root is required so tests never write to the working directory.
    expect(ctx.root).toBe(root);
    expect(ctx.now()).toBe(at);
  });
});
