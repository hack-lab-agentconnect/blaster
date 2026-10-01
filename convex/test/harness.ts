import { convexTest } from "convex-test";
import schema from "../schema.js";
import { modules } from "./modules.js";

/**
 * The shared test harness.
 *
 * `convexTest(schema, modules)` runs the real functions against an in-memory
 * backend, so schema validation, indexes, and transaction semantics all apply —
 * which is the point. A pure unit test cannot see a wrong index match or a
 * transaction that writes in the wrong order, and those are the defects this
 * codebase has actually shipped.
 *
 * No deployment, no `CONVEX_URL`, no credentials: everything runs in-process.
 */
export function testBackend() {
  return convexTest(schema, modules);
}

export type TestBackend = ReturnType<typeof testBackend>;

/**
 * A `phoneNumbers` ledger row, which a pool membership points at.
 *
 * The pool relation stores `phoneNumberId`, so a pool cannot be exercised
 * without a ledger row for each number — this is that row, with only the fields
 * a send decision reads.
 */
export async function seedPhoneNumber(
  t: TestBackend,
  phoneNumber: string,
  messagingProfileId?: string,
): Promise<string> {
  return t.run(async (ctx) =>
    ctx.db.insert("phoneNumbers", {
      phoneNumber,
      ...(messagingProfileId ? { messagingProfileId } : {}),
      status: "active",
    }),
  );
}

/**
 * A `sequences` row. A sequence is the unit an enrollment and a pool assignment
 * hang off, so almost every test needs one.
 */
export async function seedSequence(
  t: TestBackend,
  args: {
    name?: string;
    fromNumber: string;
    poolId?: string;
    campaignId?: string;
    status?: "draft" | "active" | "paused" | "completed";
  },
): Promise<string> {
  return t.run(async (ctx) =>
    ctx.db.insert("sequences", {
      name: args.name ?? "test sequence",
      status: args.status ?? "active",
      fromNumber: args.fromNumber,
      ...(args.poolId ? { poolId: args.poolId as never } : {}),
      ...(args.campaignId ? { campaignId: args.campaignId } : {}),
      stepCount: 1,
      options: {
        stopOnReply: true,
        respectDoNotContact: true,
        requireProfileForCountry: true,
        dailyCapPerRecipient: 0,
      },
      createdAt: Date.now(),
    }),
  );
}

/** A `pools` row, in the state `createPool` would leave it. */
export async function seedPool(
  t: TestBackend,
  args: { name?: string; minSpacingMs?: number; dailyCapPerNumber?: number; status?: "active" | "paused" } = {},
): Promise<string> {
  return t.run(async (ctx) =>
    ctx.db.insert("pools", {
      name: args.name ?? "test pool",
      status: args.status ?? "active",
      strategy: "sequential",
      cursor: -1,
      minSpacingMs: args.minSpacingMs ?? 1_000,
      dailyCapPerNumber: args.dailyCapPerNumber ?? 0,
      activeNumberCount: 0,
      nextAvailableAt: 0,
      createdAt: Date.now(),
    }),
  );
}

/**
 * Assert a result is not null and return it, so a test reads its fields without
 * a null check on every line. `getPool`/`getPhoneNumber` return null for an
 * unknown id, and a test that means "this exists" should say that once rather
 * than `!` on every access.
 */
export function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value, got none");
  return value;
}
