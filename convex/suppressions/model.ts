import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { normalizePhoneNumber } from "../../packages/core/src/conversation/history/helpers/pair.js";

/**
 * Durable, per-person contact suppression.
 *
 * One implementation of "is this peer suppressed", shared by the enroll path
 * and the send path so the two cannot disagree. The row is keyed on the peer
 * alone (see `schema/suppressions.ts`): the STOP is about the person, so it
 * holds across every sequence and every number a pool might send from.
 */

/** Whether this peer is suppressed right now. */
export async function isSuppressed(ctx: QueryCtx | MutationCtx, peer: string): Promise<boolean> {
  const normalized = normalizePhoneNumber(peer);
  if (!normalized) return false;
  const row = await ctx.db
    .query("suppressions")
    .withIndex("peer", (q) => q.eq("peer", normalized))
    .first();
  return row !== null;
}

/**
 * Record a suppression, idempotently.
 *
 * Called by the inbound opt-out path in the same transaction that stores the
 * message, so a stored STOP and its suppression cannot disagree. Keyed on the
 * peer, so a second STOP from the same person is a no-op rather than a
 * duplicate row.
 */
export async function suppressPeer(
  ctx: MutationCtx,
  peer: string,
  options: {
    reason?: string;
    source?: "inbound-opt-out" | "manual";
    conversationId?: string;
    now?: number;
  } = {},
): Promise<boolean> {
  const normalized = normalizePhoneNumber(peer);
  if (!normalized) return false;
  const existing = await ctx.db
    .query("suppressions")
    .withIndex("peer", (q) => q.eq("peer", normalized))
    .first();
  if (existing) return false;
  await ctx.db.insert("suppressions", {
    peer: normalized,
    ...(options.reason ? { reason: options.reason } : {}),
    source: options.source ?? "inbound-opt-out",
    ...(options.conversationId ? { conversationId: options.conversationId as never } : {}),
    createdAt: options.now ?? Date.now(),
  });
  return true;
}

/**
 * Lift a suppression. Only an explicit human action calls this, which is why it
 * deletes the row rather than flipping a flag: there is no field a later
 * automation could accidentally write to reopen contact.
 */
export async function liftSuppression(ctx: MutationCtx, peer: string): Promise<boolean> {
  const normalized = normalizePhoneNumber(peer);
  if (!normalized) return false;
  const row = await ctx.db
    .query("suppressions")
    .withIndex("peer", (q) => q.eq("peer", normalized))
    .first();
  if (!row) return false;
  await ctx.db.delete("suppressions", row._id);
  return true;
}
