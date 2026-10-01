import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * The pool domain's types and the validators they are derived from.
 *
 * Every shape the domain needs is declared here exactly once and inferred back
 * into TypeScript, so a validator and its type cannot drift apart (R11).
 *
 * Document ids are spelled `GenericId` over the table name rather than imported
 * from `_generated/dataModel`, because `dataModel.d.ts` imports `schema.ts` and
 * `schema/pool.ts` is part of it; importing the generated `Id` here would close
 * that cycle and evaluate every validator to `undefined` at module load. The
 * same leaf discipline is used by the sequence domain (see sequence/types.ts).
 */

/** Whether a pool is dispatching at all. */
export const poolStatusValidator = v.union(v.literal("active"), v.literal("paused"));
export type PoolStatus = Infer<typeof poolStatusValidator>;

/** Where one number sits in a pool. `removed` keeps the audit. */
export const poolMemberStatusValidator = v.union(
  v.literal("active"),
  v.literal("paused"),
  v.literal("removed"),
);
export type PoolMemberStatus = Infer<typeof poolMemberStatusValidator>;

/** Only sequential dispatch is implemented; the field is the seam for more. */
export const poolStrategyValidator = v.union(v.literal("sequential"));
export type PoolStrategy = Infer<typeof poolStrategyValidator>;

export const createPoolArgsValidator = v.object({
  name: v.string(),
  minSpacingMs: v.optional(v.number()),
  dailyCapPerNumber: v.optional(v.number()),
});
export type CreatePoolArgs = Infer<typeof createPoolArgsValidator>;

export const setPoolStatusArgsValidator = v.object({
  poolId: v.id("pools"),
  status: poolStatusValidator,
});
export type SetPoolStatusArgs = Infer<typeof setPoolStatusArgsValidator>;

export const assignNumberArgsValidator = v.object({
  poolId: v.id("pools"),
  phoneNumber: v.string(),
  /** Appends to the end when omitted. */
  order: v.optional(v.number()),
});
export type AssignNumberArgs = Infer<typeof assignNumberArgsValidator>;

export const removeNumberArgsValidator = v.object({
  poolId: v.id("pools"),
  phoneNumber: v.string(),
});
export type RemoveNumberArgs = Infer<typeof removeNumberArgsValidator>;

export const reorderNumbersArgsValidator = v.object({
  poolId: v.id("pools"),
  /** E.164 numbers, in the order they should be worked. */
  order: v.array(v.string()),
});
export type ReorderNumbersArgs = Infer<typeof reorderNumbersArgsValidator>;

export const consumeSenderArgsValidator = v.object({
  poolId: v.id("pools"),
  /**
   * The `order` `availableSender` proposed. The mutation reserves *that* member
   * rather than re-selecting, so the number the runner evaluated eligibility
   * with, charged capacity for, and sends from are the same by construction.
   */
  order: v.number(),
  now: v.optional(v.number()),
});
export type ConsumeSenderArgs = Infer<typeof consumeSenderArgsValidator>;
