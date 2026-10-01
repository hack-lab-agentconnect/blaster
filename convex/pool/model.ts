import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { selectSender } from "../../packages/core/src/pipeline/pool/index.js";
import { DAY_MS, memberState } from "./utils.js";
import {
  membersOf,
  policyOf,
  rollupOf,
  senderForRow,
  type SenderAvailability,
} from "./helpers.js";

/**
 * Context-bound writes for the pool domain.
 *
 * Membership changes and the atomic consumption of one sender's budget live
 * here. Every function keeps the pool's rollup fields current in the same
 * transaction, so the status surface never reads a stale count.
 */

/** The next sequential position, after every membership including removed. */
function nextOrder(rows: Doc<"poolNumbers">[]): number {
  return rows.reduce((max, row) => Math.max(max, row.order), -1) + 1;
}

/** Write the pool's rollup fields from its current membership. */
async function writeRollup(
  ctx: MutationCtx,
  pool: Doc<"pools">,
  poolId: Id<"pools">,
  now: number,
): Promise<void> {
  const rows = await membersOf(ctx, poolId);
  await ctx.db.patch("pools", poolId, rollupOf(pool, rows, now));
}

/**
 * Add a number to a pool, or reactivate one that was removed.
 *
 * Keyed on `phoneNumberId`, so assigning the same number twice updates its
 * membership rather than creating a duplicate. A number that left and returns
 * keeps its row — and its audit — and is simply marked active again.
 */
export async function assignNumber(
  ctx: MutationCtx,
  poolId: Id<"pools">,
  phoneNumberId: Id<"phoneNumbers">,
  phoneNumber: string,
  order: number | undefined,
  now: number,
): Promise<Id<"poolNumbers">> {
  const pool = await ctx.db.get("pools", poolId);
  if (!pool) throw new Error(`unknown pool ${poolId}`);
  const existing = await ctx.db
    .query("poolNumbers")
    .withIndex("poolPhoneNumber", (q) =>
      q.eq("poolId", poolId).eq("phoneNumberId", phoneNumberId),
    )
    .unique();
  if (existing) {
    const nextOrderForRow = order ?? existing.order;
    await ctx.db.patch("poolNumbers", existing._id, {
      phoneNumber,
      order: nextOrderForRow,
      status: "active",
      removedAt: undefined,
    });
    await writeRollup(ctx, pool, poolId, now);
    return existing._id;
  }
  const finalOrder = order ?? nextOrder(await membersOf(ctx, poolId));
  const id = await ctx.db.insert("poolNumbers", {
    poolId,
    phoneNumberId,
    phoneNumber,
    order: finalOrder,
    status: "active",
    dayStartedAt: now,
    sentToday: 0,
    nextAvailableAt: 0,
    assignedAt: now,
  });
  await writeRollup(ctx, pool, poolId, now);
  return id;
}

/**
 * Mark a number as removed from a pool and compact the remaining order.
 *
 * A soft removal rather than a delete: an in-flight send whose sender was
 * already chosen still resolves, and the record that the number was here is
 * kept. Removing the last active number is allowed; the runner parks the
 * enrollment for a human rather than sending into an empty pool.
 */
export async function removeNumber(
  ctx: MutationCtx,
  poolId: Id<"pools">,
  phoneNumberId: Id<"phoneNumbers">,
  now: number,
): Promise<Id<"poolNumbers">> {
  const pool = await ctx.db.get("pools", poolId);
  if (!pool) throw new Error(`unknown pool ${poolId}`);
  const existing = await ctx.db
    .query("poolNumbers")
    .withIndex("poolPhoneNumber", (q) =>
      q.eq("poolId", poolId).eq("phoneNumberId", phoneNumberId),
    )
    .unique();
  if (!existing) throw new Error(`number is not in pool ${poolId}`);
  await ctx.db.patch("poolNumbers", existing._id, { status: "removed", removedAt: now });
  await compact(ctx, poolId);
  await writeRollup(ctx, pool, poolId, now);
  return existing._id;
}

/** Renumber the live memberships so `order` stays contiguous from zero. */
async function compact(ctx: MutationCtx, poolId: Id<"pools">): Promise<void> {
  const rows = (await membersOf(ctx, poolId)).filter((row) => row.status !== "removed");
  for (const [index, row] of rows.entries()) {
    if (row.order !== index) await ctx.db.patch("poolNumbers", row._id, { order: index });
  }
}

/**
 * Set the order numbers are worked in.
 *
 * The list is E.164 numbers; any live member not named keeps its relative
 * position after the named ones, so a partial reorder is a move rather than an
 * accidental removal of everything unlisted.
 */
export async function reorderNumbers(
  ctx: MutationCtx,
  poolId: Id<"pools">,
  order: string[],
  now: number,
): Promise<void> {
  const pool = await ctx.db.get("pools", poolId);
  if (!pool) throw new Error(`unknown pool ${poolId}`);
  const rows = await membersOf(ctx, poolId);
  const byNumber = new Map(rows.map((row) => [row.phoneNumber, row]));
  const named = new Set<string>();
  let position = 0;
  for (const phoneNumber of order) {
    const row = byNumber.get(phoneNumber);
    if (!row) continue;
    await ctx.db.patch("poolNumbers", row._id, { order: position });
    named.add(phoneNumber);
    position += 1;
  }
  for (const row of rows) {
    if (named.has(row.phoneNumber)) continue;
    if (row.order !== position) await ctx.db.patch("poolNumbers", row._id, { order: position });
    position += 1;
  }
  await writeRollup(ctx, pool, poolId, now);
}

/**
 * Reserve one sender for a send, spending its budget atomically.
 *
 * This is the only function that advances the pool. It selects the same member
 * the read-side would, then increments that member's counters, advances the
 * cursor, and refreshes the rollup in one transaction — so two callers cannot
 * both spend the last unit of one number's allowance.
 */
export async function consume(
  ctx: MutationCtx,
  poolId: Id<"pools">,
  now: number,
): Promise<SenderAvailability> {
  const pool = await ctx.db.get("pools", poolId);
  if (!pool || pool.status !== "active") return { sender: null, soonestNextAvailableAt: null };

  const rows = await membersOf(ctx, poolId);
  const policy = policyOf(pool);
  const selection = selectSender(rows.map(memberState), pool.cursor, now, policy);
  if (selection.order === null) {
    await ctx.db.patch("pools", poolId, { nextAvailableAt: selection.soonestNextAvailableAt ?? now });
    return { sender: null, soonestNextAvailableAt: selection.soonestNextAvailableAt };
  }

  const row = rows.find((candidate) => candidate.order === selection.order);
  if (!row) return { sender: null, soonestNextAvailableAt: null };

  const rolled = now - row.dayStartedAt >= DAY_MS;
  await ctx.db.patch("poolNumbers", row._id, {
    sentToday: (rolled ? 0 : row.sentToday) + 1,
    dayStartedAt: rolled ? now : row.dayStartedAt,
    lastSentAt: now,
    nextAvailableAt: now + policy.minSpacingMs,
  });

  const updated = await membersOf(ctx, poolId);
  await ctx.db.patch("pools", poolId, {
    cursor: row.order,
    ...rollupOf(pool, updated, now),
    lastDispatchedAt: now,
  });
  return { sender: await senderForRow(ctx, row), soonestNextAvailableAt: null };
}
