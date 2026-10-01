import type { QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { availableAt, selectSender } from "../../packages/core/src/pipeline/pool/index.js";
import { memberState, nonNegative } from "./utils.js";

/**
 * Context-bound reads for the pool domain.
 *
 * The runner reaches the database through these because a Convex action has no
 * `db`. Keeping the read logic here rather than inline in the action means there
 * is one implementation of "which number may send now", and both the query the
 * action calls and the mutation that consumes a sender use it.
 */

/** One number to send from, resolved from its pool membership. */
export interface PoolSender {
  phoneNumber: string;
  messagingProfileId?: string;
  order: number;
}

/** What a pool can offer right now, and when it next can when it offers none. */
export interface SenderAvailability {
  sender: PoolSender | null;
  soonestNextAvailableAt: number | null;
}

/**
 * Every membership of a pool, in `order`.
 *
 * A pool's membership is bounded by the numbers an operator put in it, so this
 * is a bounded read rather than a table scan. It is used by selection, by the
 * rollup, and by the status query.
 */
export async function membersOf(ctx: QueryCtx, poolId: Id<"pools">): Promise<Doc<"poolNumbers">[]> {
  // eslint-disable-next-line @convex-dev/no-collect-in-query
  const rows = await ctx.db
    .query("poolNumbers")
    .withIndex("poolOrder", (q) => q.eq("poolId", poolId))
    .collect();
  return rows.sort((a, b) => a.order - b.order);
}

/** The pool's rate policy, from the pool row. */
export function policyOf(pool: Doc<"pools">) {
  return {
    minSpacingMs: nonNegative(pool.minSpacingMs, 0),
    dailyCapPerNumber: nonNegative(pool.dailyCapPerNumber, 0),
  };
}

/** Resolve a chosen membership to the number and profile a send needs. */
export async function senderForRow(
  ctx: QueryCtx,
  row: Doc<"poolNumbers">,
): Promise<PoolSender> {
  const number = await ctx.db.get("phoneNumbers", row.phoneNumberId);
  return {
    phoneNumber: row.phoneNumber,
    ...(number?.messagingProfileId ? { messagingProfileId: number.messagingProfileId } : {}),
    order: row.order,
  };
}

/**
 * Whether a pool contained this E.164 number (and has not removed it).
 *
 * Used by the conversations domain to attribute a thread to a pool-backed
 * sequence: such a sequence has a `poolId` and a fixed `fromNumber` that is not
 * the number it actually sends from, so matching on `fromNumber` alone leaves
 * every pool-backed thread unassigned.
 */
export async function poolContainsNumber(
  ctx: QueryCtx,
  poolId: Id<"pools">,
  phoneNumber: string,
): Promise<boolean> {
  const row = await ctx.db
    .query("poolNumbers")
    .withIndex("poolPhone", (q) => q.eq("poolId", poolId).eq("phoneNumber", phoneNumber))
    .first();
  return row !== null && row.status !== "removed";
}

/**
 * The next number that may send, computed without consuming any budget.
 *
 * The runner calls this before it claims a step to decide whether to send or
 * defer. It is deliberately a read: the budget is consumed by the mutation that
 * actually reserves the sender, so a step that loses its claim cannot spend a
 * number's allowance.
 */
export async function availableSender(
  ctx: QueryCtx,
  poolId: Id<"pools">,
  now: number,
): Promise<SenderAvailability> {
  const pool = await ctx.db.get("pools", poolId);
  if (!pool || pool.status !== "active") return { sender: null, soonestNextAvailableAt: null };

  const rows = await membersOf(ctx, poolId);
  const policy = policyOf(pool);
  const selection = selectSender(rows.map(memberState), pool.cursor, now, policy);
  if (selection.order === null) {
    return { sender: null, soonestNextAvailableAt: selection.soonestNextAvailableAt };
  }
  const row = rows.find((candidate) => candidate.order === selection.order);
  if (!row) return { sender: null, soonestNextAvailableAt: selection.soonestNextAvailableAt };
  return { sender: await senderForRow(ctx, row), soonestNextAvailableAt: null };
}

/**
 * The pool's rollup status, recomputed from its members.
 *
 * `nextAvailableAt` is the earliest instant *any* member may send, so a caller
 * that sees no sender available now knows exactly when to try again.
 */
export function rollupOf(pool: Doc<"pools">, rows: Doc<"poolNumbers">[], now: number) {
  const policy = policyOf(pool);
  const active = rows.filter((row) => row.status === "active");
  if (active.length === 0) return { activeNumberCount: 0, nextAvailableAt: now };
  let soonest = Number.POSITIVE_INFINITY;
  for (const row of active) {
    soonest = Math.min(soonest, availableAt(memberState(row), now, policy));
  }
  return {
    activeNumberCount: active.length,
    nextAvailableAt: Number.isFinite(soonest) ? Math.max(soonest, now) : now,
  };
}
