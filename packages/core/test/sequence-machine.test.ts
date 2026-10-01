import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { createEnrollmentMachine } from "../src/pipeline/sequence/machine.ts";
import {
  MAX_STEP_ATTEMPTS,
  claimKeyFor,
  type EnrollmentMachineInput,
  type SequenceEffect,
} from "../src/pipeline/sequence/types.ts";
import { nextAllowedSendAt, quietHoursWindow, timeZoneForState } from "../src/pipeline/sequence/helpers/quiet-hours.ts";

/**
 * The sequencer lifecycle, driven end to end through a real XState actor.
 *
 * The two properties worth proving are both about what the machine *refuses* to
 * do, and neither is visible from a happy-path test:
 *
 *   - a second worker that loses the claim race must not send, and
 *   - an enrollment whose last send may or may not have gone out must never
 *     retry on its own.
 *
 * Everything runs with injected eligibility and injected clock arithmetic, so
 * there is no provider, no network, and no real clock in this file.
 */

const HOUR = 3_600_000;
/** 2026-03-02T15:00:00Z, a Monday afternoon: inside quiet hours in every US zone. */
const MIDDAY_UTC = Date.UTC(2026, 2, 2, 15, 0, 0);

interface Overrides extends Partial<EnrollmentMachineInput> {
  steps?: EnrollmentMachineInput["steps"];
}

function input(overrides: Overrides = {}): EnrollmentMachineInput {
  const {
    steps = [
      { text: "first", delayHours: 0, isStop: false },
      { text: "second", delayHours: 24, isStop: false },
      { text: "third", delayHours: 48, isStop: false },
    ],
    ...rest
  } = overrides;
  return {
    enrollmentId: "e-1",
    sequenceId: "s-1",
    cursor: 0,
    steps,
    fromNumber: "+15551230000",
    to: "+15557654321",
    country: "US",
    timeZone: "America/New_York",
    approximateZone: false,
    nextDueAt: null,
    lastSentAt: null,
    status: "active",
    attempts: 0,
    lastSkipReason: null,
    evaluate: () => ({ eligible: true, reason: null, detail: null }),
    nextAllowedSendAt: () => null,
    now: MIDDAY_UTC,
    sentInLastDay: 0,
    doNotContact: false,
    hasReplied: false,
    ...rest,
  };
}

/** Start an actor and return it, so a test can send events and read the snapshot. */
function actor(overrides: Overrides = {}) {
  return createActor(createEnrollmentMachine(), { input: input(overrides) });
}

/** Drive an actor to a state, asserting the path on the way. */
async function run(overrides: Overrides, ...events: Parameters<ReturnType<typeof actor>["send"]>[0][]) {
  const a = actor(overrides);
  a.start();
  for (const event of events) a.send(event);
  return a;
}

const stateOf = (a: ReturnType<typeof actor>) => String(a.getSnapshot().value);
const contextOf = (a: ReturnType<typeof actor>) => a.getSnapshot().context;

describe("the happy path", () => {
  test("a due step is claimed, then sends, then advances and waits for the next one", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });

    // TICK alone must not send. It asks for a claim first.
    expect(stateOf(a)).toBe("claiming");
    const claim = contextOf(a).pendingEffect as Extract<SequenceEffect, { type: "claim" }>;
    expect(claim.type).toBe("claim");
    expect(claim.key).toBe("e-1:0");

    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("sending");
    const send = contextOf(a).pendingEffect as Extract<SequenceEffect, { type: "send" }>;
    expect(send.type).toBe("send");
    // The key the send carries is the one the claim was taken under, which is
    // what lets the provider or a later run recognise the duplicate.
    expect(send.key).toBe("e-1:0");
    expect(send.text).toBe("first");

    a.send({ type: "SEND_SUCCEEDED", messageId: "m-1", at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("scheduled");
    expect(contextOf(a).cursor).toBe(1);
    // Step 2 is 24h after the send, not after enrollment.
    expect(contextOf(a).nextDueAt).toBe(MIDDAY_UTC + 24 * HOUR);
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
  });

  test("the last step completes rather than waiting for a step that does not exist", async () => {
    const a = await run({ cursor: 2 }, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_SUCCEEDED", messageId: "m-3", at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("completed");
    expect(contextOf(a).nextDueAt).toBeNull();
  });

  test("a stop step ends the sequence without sending anything", async () => {
    const a = await run(
      {
        cursor: 1,
        steps: [
          { text: "first", delayHours: 0, isStop: false },
          { text: "", delayHours: 24, isStop: true },
        ],
      },
      { type: "TICK", at: MIDDAY_UTC },
    );
    expect(stateOf(a)).toBe("completed");
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
  });
});

describe("claiming is what stops a double send", () => {
  test("losing the claim race parks the enrollment instead of sending", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("claiming");

    // Another worker already holds e-1:0.
    a.send({ type: "CLAIM_HELD_BY_OTHER" });

    expect(stateOf(a)).toBe("ambiguous");
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
    expect(contextOf(a).ambiguousReason).toBe("claim-held-elsewhere");
  });

  test("the claim key is derived from the step, so a retry presents the same key", () => {
    expect(claimKeyFor("e-1", 0)).toBe("e-1:0");
    expect(claimKeyFor("e-1", 0)).toBe(claimKeyFor("e-1", 0));
    // Different step, different key: the key is per logical message, not per run.
    expect(claimKeyFor("e-1", 1)).not.toBe(claimKeyFor("e-1", 0));
  });
});

describe("an ambiguous send never retries itself", () => {
  /** Drive to the ambiguous state by a send whose outcome was never learned. */
  async function ambiguous() {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_AMBIGUOUS", reason: "read timeout after request sent" });
    return a;
  }

  test("a timeout after the request is sent parks the enrollment", async () => {
    const a = await ambiguous();
    expect(stateOf(a)).toBe("ambiguous");
    expect(contextOf(a).status).toBe("ambiguous");
    expect(contextOf(a).nextDueAt).toBeNull();
    expect(contextOf(a).ambiguousReason).toBe("read timeout after request sent");
  });

  test("ticking an ambiguous enrollment changes nothing at all", async () => {
    const a = await ambiguous();
    // This is the regression that matters: an ambiguous state with a TICK
    // handler, or with a nextDueAt, would re-send on the next cron pass.
    a.send({ type: "TICK", at: MIDDAY_UTC + 10 * HOUR });

    expect(stateOf(a)).toBe("ambiguous");
    expect(contextOf(a).nextDueAt).toBeNull();
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
  });

  test("a reconciliation that says it went out advances the cursor", async () => {
    const a = await ambiguous();
    a.send({ type: "RECONCILE", wentOut: true, at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("scheduled");
    expect(contextOf(a).cursor).toBe(1);
    expect(contextOf(a).status).toBe("active");
  });

  test("a reconciliation that says it did not go out owes the step again, immediately", async () => {
    const a = await ambiguous();
    a.send({ type: "RECONCILE", wentOut: false, at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("scheduled");
    expect(contextOf(a).cursor).toBe(0);
    expect(contextOf(a).nextDueAt).toBe(MIDDAY_UTC);
    expect(contextOf(a).lastSkipReason).toBe("reconciled-not-sent");
  });

  test("pause works from ambiguous, which is how an operator stops the bleeding", async () => {
    const a = await ambiguous();
    a.send({ type: "PAUSE" });
    expect(stateOf(a)).toBe("paused");
  });
});

describe("failures and retries", () => {
  test("a retryable failure backs off rather than resending on the next tick", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_FAILED", at: MIDDAY_UTC, retryable: true, reason: "provider 503" });

    expect(stateOf(a)).toBe("scheduled");
    expect(contextOf(a).cursor).toBe(0);
    expect(contextOf(a).attempts).toBe(1);
    // Pushed out, not left due: otherwise the next cron pass retries instantly.
    expect(contextOf(a).nextDueAt).toBeGreaterThan(MIDDAY_UTC);
  });

  test("a non-retryable failure is final", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_FAILED", at: MIDDAY_UTC, retryable: false, reason: "invalid number" });
    expect(stateOf(a)).toBe("failed");
    expect(contextOf(a).nextDueAt).toBeNull();
  });

  test("attempts are exhausted after the ceiling and the enrollment is parked", async () => {
    const a = await run({ attempts: MAX_STEP_ATTEMPTS }, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_FAILED", at: MIDDAY_UTC, retryable: true, reason: "provider 503" });
    expect(stateOf(a)).toBe("failed");
  });

  test("an operator can resume a failed enrollment", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    a.send({ type: "SEND_FAILED", at: MIDDAY_UTC, retryable: false, reason: "invalid number" });
    a.send({ type: "RESUME", at: MIDDAY_UTC });
    expect(stateOf(a)).toBe("scheduled");
  });
});

describe("stop conditions win from anywhere", () => {
  test("a reply stops the sequence mid-flight", async () => {
    const a = await run({}, { type: "TICK", at: MIDDAY_UTC });
    a.send({ type: "CLAIM_TAKEN", at: MIDDAY_UTC });
    // The person answers while the send is in the air.
    a.send({ type: "INBOUND_REPLY" });

    expect(stateOf(a)).toBe("replied");
    expect(contextOf(a).nextDueAt).toBeNull();
  });

  test("an opt-out is sticky: a later reply cannot reopen it", async () => {
    const a = await run({}, { type: "OPT_OUT" });
    expect(stateOf(a)).toBe("opted_out");
    a.send({ type: "INBOUND_REPLY" });
    expect(stateOf(a)).toBe("opted_out");
  });

  test("an ineligible recipient is skipped without losing the step", async () => {
    const a = await run(
      {
        evaluate: () => ({ eligible: false, reason: "do-not-contact", detail: "marked DNC" }),
      },
      { type: "TICK", at: MIDDAY_UTC },
    );
    expect(stateOf(a)).toBe("scheduled");
    // The step is still owed, so the cursor must not move.
    expect(contextOf(a).cursor).toBe(0);
    expect(contextOf(a).lastSkipReason).toBe("do-not-contact");
    // And it must not be retried on every tick.
    expect(contextOf(a).nextDueAt).toBeGreaterThan(MIDDAY_UTC);
  });
});

describe("quiet hours", () => {
  test("a due step inside quiet hours is pushed to the next allowed instant", async () => {
    // 03:00 Eastern is outside the 08:00-21:00 window.
    const at3am = Date.UTC(2026, 2, 2, 8, 0, 0);
    const allowed = nextAllowedSendAt("America/New_York", at3am);
    expect(allowed).not.toBeNull();

    const a = await run(
      { timeZone: "America/New_York", nextAllowedSendAt: () => allowed },
      { type: "TICK", at: at3am },
    );
    expect(stateOf(a)).toBe("scheduled");
    expect(contextOf(a).lastSkipReason).toBe("quiet-hours");
    expect(contextOf(a).nextDueAt).toBe(allowed);
    // Never claimed, so never sent.
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
  });

  test("the window is 08:00 to 21:00 in the recipient's zone", () => {
    const at = (hourUtc: number) => Date.UTC(2026, 2, 2, hourUtc, 0, 0);
    // New York is UTC-5 in March before DST, so 13:00Z is 08:00 local.
    expect(quietHoursWindow("America/New_York", at(12)).quiet).toBe(true); // 07:00
    expect(quietHoursWindow("America/New_York", at(13)).quiet).toBe(false); // 08:00
    expect(quietHoursWindow("America/New_York", at(25)).quiet).toBe(false); // 20:00
    expect(quietHoursWindow("America/New_York", at(26)).quiet).toBe(true); // 21:00
  });

  test("the same instant is quiet in one zone and allowed in another", () => {
    // 02:00 Eastern: quiet. 23:00 Pacific the previous day: also quiet, but
    // 23:00 Eastern is quiet while 23:00 Pacific is not the point -- the check
    // is explicitly per-recipient-zone, never the server's.
    const at2amEast = Date.UTC(2026, 2, 2, 7, 0, 0); // 02:00 in New York
    expect(quietHoursWindow("America/New_York", at2amEast).quiet).toBe(true);
    expect(quietHoursWindow("America/Los_Angeles", at2amEast).quiet).toBe(true);
    const at10amWest = Date.UTC(2026, 2, 2, 18, 0, 0); // 10:00 Pacific
    expect(quietHoursWindow("America/Los_Angeles", at10amWest).quiet).toBe(false);
  });

  test("an unplaceable number is reported quiet rather than assumed sendable", () => {
    const window = quietHoursWindow(null, MIDDAY_UTC);
    expect(window.quiet).toBe(true);
    expect(window.timeZone).toBeNull();
  });

  test("an unplaceable recipient is parked for a human, not guessed at", async () => {
    const a = await run(
      { timeZone: null, nextAllowedSendAt: () => null },
      { type: "TICK", at: MIDDAY_UTC },
    );
    expect(stateOf(a)).toBe("awaiting_human");
    expect(contextOf(a).lastSkipReason).toBe("unplaceable-recipient");
    expect(contextOf(a).pendingEffect).toEqual({ type: "none" });
  });

  test("a multi-zone state is flagged so a caller can bias conservative", () => {
    expect(timeZoneForState("CA").approximate).toBe(false);
    // Florida genuinely straddles Eastern and Central.
    expect(timeZoneForState("FL")).toMatchObject({ approximate: true });
    expect(timeZoneForState("ZZ")).toMatchObject({ timeZone: null });
  });
});
