import { v } from "convex/values";
import type { Infer } from "convex/values";

/**
 * The suppression domain's types and validators.
 *
 * Leaf module: nothing here reaches back into the schema, so importing it from
 * `schema/suppressions.ts` or a function file cannot close a cycle.
 */

export const suppressionSourceValidator = v.union(
  v.literal("inbound-opt-out"),
  v.literal("manual"),
);
export type SuppressionSource = Infer<typeof suppressionSourceValidator>;

export const suppressArgsValidator = v.object({
  peer: v.string(),
  reason: v.optional(v.string()),
  source: v.optional(suppressionSourceValidator),
});
export type SuppressArgs = Infer<typeof suppressArgsValidator>;

export const liftArgsValidator = v.object({
  peer: v.string(),
});
export type LiftArgs = Infer<typeof liftArgsValidator>;
