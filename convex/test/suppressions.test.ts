import { describe, expect, test } from "vitest";
import { required, seedPhoneNumber, seedSequence, testBackend } from "./harness.js";
import { ref } from "./refs.js";

/**
 * The suppression model, end to end.
 *
 * Ticket 01's decision, exercised against a real runtime: a STOP is a fact
 * about the person, not the enrollment, so it must survive into every other
 * sequence and block enrollment there — which is exactly what the per-enrollment
 * `opted-out` status could not do.
 */

type Backend = ReturnType<typeof testBackend>;

async function seedActiveEnrollment(t: Backend, sequenceId: string, to: string) {
  return t.run(async (ctx) =>
    ctx.db.insert("sequenceEnrollments", {
      sequenceId: sequenceId as never,
      recipientId: `prospect-${to}`,
      to,
      cursor: 0,
      status: "active",
      enrolledAt: 1,
      nextDueAt: 1,
    }),
  );
}

describe("suppression: written by an inbound STOP", () => {
  test("a STOP suppresses the peer and stops the enrollment, in one transaction", async () => {
    const t = testBackend();
    const sequenceId = await seedSequence(t, { fromNumber: "+15550000001" });
    await seedActiveEnrollment(t, sequenceId, "+13125550001");

    const result = await t.mutation(ref.recordInboundMessage, {
      from: "+13125550001",
      to: "+15550000001",
      body: "STOP",
      providerEventId: "evt-stop-a",
      receivedAt: 2,
      optedOut: true,
    });

    expect(result.status).toBe("stored");
    expect(required(result.stoppedEnrollments[0]).status).toBe("opted-out");
    expect(result.suppressed).toBe(true);
    expect(await t.query(ref.isPeerSuppressed, { peer: "+13125550001" })).toBe(true);
  });

  test("a plain reply does not suppress", async () => {
    const t = testBackend();
    const sequenceId = await seedSequence(t, { fromNumber: "+15550000001" });
    await seedActiveEnrollment(t, sequenceId, "+13125550002");

    await t.mutation(ref.recordInboundMessage, {
      from: "+13125550002",
      to: "+15550000001",
      body: "hey, tell me more",
      providerEventId: "evt-reply-a",
      receivedAt: 2,
    });

    expect(await t.query(ref.isPeerSuppressed, { peer: "+13125550002" })).toBe(false);
  });

  test("a second STOP is idempotent", async () => {
    const t = testBackend();
    await t.mutation(ref.recordInboundMessage, {
      from: "+13125550003",
      to: "+15550000001",
      body: "STOP",
      providerEventId: "evt-stop-b1",
      receivedAt: 2,
      optedOut: true,
    });
    const second = await t.mutation(ref.recordInboundMessage, {
      from: "+13125550003",
      to: "+15550000001",
      body: "STOP",
      providerEventId: "evt-stop-b2",
      receivedAt: 3,
      optedOut: true,
    });
    expect(second.suppressed).toBe(false);
    // Test-only reads of tables this test itself seeded; bounded by the test.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const rows = await t.run(async (ctx) => ctx.db.query("suppressions").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("suppression: blocks enrollment across sequences", () => {
  test("enrolling a suppressed peer is refused", async () => {
    const t = testBackend();
    // Suppressed by a STOP in one sequence.
    await t.mutation(ref.recordInboundMessage, {
      from: "+13125550004",
      to: "+15550000001",
      body: "STOP",
      providerEventId: "evt-stop-c",
      receivedAt: 2,
      optedOut: true,
    });
    // A different sequence must not be able to enroll them.
    const other = await seedSequence(t, { name: "other", fromNumber: "+15550000002" });
    await expect(
      t.mutation(ref.enroll, { sequenceId: other, recipientId: "p", to: "+13125550004" }),
    ).rejects.toThrow(/suppressed/);
  });

  test("the enrollment is allowed once the suppression is lifted", async () => {
    const t = testBackend();
    await t.mutation(ref.recordInboundMessage, {
      from: "+13125550005",
      to: "+15550000001",
      body: "STOP",
      providerEventId: "evt-stop-d",
      receivedAt: 2,
      optedOut: true,
    });
    const lifted = await t.mutation(ref.lift, { peer: "+13125550005" });
    expect(lifted.lifted).toBe(true);

    const sequenceId = await seedSequence(t, { fromNumber: "+15550000001" });
    const id = await t.mutation(ref.enroll, {
      sequenceId,
      recipientId: "p",
      to: "+13125550005",
    });
    expect(id).toBeTruthy();
  });

  test("a manual suppression has its own source", async () => {
    const t = testBackend();
    await t.mutation(ref.suppress, { peer: "+13125550006", reason: "operator decision" });
    expect(await t.query(ref.isPeerSuppressed, { peer: "+13125550006" })).toBe(true);
    const row = required(await t.run(async (ctx) => ctx.db.query("suppressions").first()));
    expect(row.source).toBe("manual");
    expect(row.reason).toBe("operator decision");
  });

  test("normalizes the peer, so formatting cannot dodge a suppression", async () => {
    const t = testBackend();
    await t.mutation(ref.suppress, { peer: "+13125550007" });
    // A differently-formatted but equal number is still suppressed.
    expect(await t.query(ref.isPeerSuppressed, { peer: "13125550007" })).toBe(true);
  });
});

describe("conversations: storage still works alongside suppression", () => {
  test("a stored STOP leaves one conversation and one message", async () => {
    const t = testBackend();
    await seedPhoneNumber(t, "+15550000009");
    await t.mutation(ref.recordInboundMessage, {
      from: "+13125550008",
      to: "+15550000009",
      body: "STOP",
      providerEventId: "evt-stop-e",
      receivedAt: 2,
      optedOut: true,
    });
    // Test-only reads of tables this test itself seeded; bounded by the test.
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const conversations = await t.run(async (ctx) => ctx.db.query("conversations").collect());
    // eslint-disable-next-line @convex-dev/no-collect-in-query
    const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(conversations).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.direction).toBe("inbound");
  });
});
