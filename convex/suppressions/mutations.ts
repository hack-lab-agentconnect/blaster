import { internalMutation, mutation, query } from "../_generated/server.js";
import { v } from "convex/values";
import { isSuppressed, liftSuppression, suppressPeer } from "./model.js";
import { liftArgsValidator, suppressArgsValidator } from "./types.js";

/**
 * Suppression reads and writes.
 *
 * Thin wrappers over model.ts. See docs/convex-naming-conventions.md (rule R5).
 */

/** Whether one peer is suppressed, for an operator or another function. */
export const isPeerSuppressed = query({
  args: { peer: v.string() },
  handler: async (ctx, args) => isSuppressed(ctx, args.peer),
});

/** Everyone currently suppressed, newest first, for an operator list. */
export const listSuppressions = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return ctx.db
      .query("suppressions")
      .withIndex("createdAt")
      .order("desc")
      .take(args.limit ?? 100);
  },
});

/**
 * Record a suppression by hand.
 *
 * `manual` rather than `inbound-opt-out`, so the list distinguishes "they told
 * us to stop" from "an operator decided this".
 */
export const suppress = mutation({
  args: suppressArgsValidator,
  handler: async (ctx, args) => {
    const created = await suppressPeer(ctx, args.peer, {
      reason: args.reason,
      source: args.source ?? "manual",
    });
    return { peer: args.peer, created };
  },
});

/**
 * Lift a suppression.
 *
 * Deliberately a human-only mutation on a public function: no automation writes
 * this path, and an inbound START does not reach it either. Lifting does not
 * resurrect a stopped enrollment; the prospect has to be enrolled again.
 */
export const lift = mutation({
  args: liftArgsValidator,
  handler: async (ctx, args) => {
    const lifted = await liftSuppression(ctx, args.peer);
    return { peer: args.peer, lifted };
  },
});

/**
 * Record a suppression from the inbound opt-out path.
 *
 * Internal, because only the webhook's `recordInboundMessage` may create a
 * suppression from a message; a client calling a public mutation could suppress
 * an arbitrary number.
 */
export const recordInboundOptOut = internalMutation({
  args: { peer: v.string(), conversationId: v.optional(v.string()), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const created = await suppressPeer(ctx, args.peer, {
      source: "inbound-opt-out",
      reason: "inbound STOP",
      ...(args.conversationId ? { conversationId: args.conversationId } : {}),
      ...(args.now === undefined ? {} : { now: args.now }),
    });
    return { peer: args.peer, created };
  },
});
