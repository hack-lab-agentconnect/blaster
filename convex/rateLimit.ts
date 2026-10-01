import { RateLimiter, SECOND } from "@convex-dev/rate-limiter";
import { components } from "./_generated/api.js";
import type { MutationCtx } from "./_generated/server.js";

/**
 * Outbound send capacity.
 *
 * Telnyx is the only provider Blaster calls from Convex, and it is the only
 * external call here with a throughput ceiling that can be hit by our own
 * behaviour rather than by a bug. Two limits, because there are two separate
 * things to protect:
 *
 *   - `telnyxSend` bounds what the deployment sends in total. This is the
 *     account-level ceiling.
 *   - `telnyxSendPerNumber` bounds what one sending number sends. Telnyx meters
 *     10DLC throughput per campaign, so one busy number must not be able to
 *     spend the whole account's budget; without this, a single number's
 *     enrollment cohort starves every other number on the account.
 *
 * The values are deliberately conservative, and the reason is in this repo's own
 * error handling rather than in Telnyx's documentation: `classifySendResult`
 * treats any 4xx as a definite failure with `retryable: false`, so a provider
 * 429 does not back off, it parks that enrollment for a human. Over-sending
 * therefore does not degrade gracefully, it fails recipients, which is why the
 * cap has to be the thing that prevents the 429 rather than recovering from it.
 * These numbers are the tuning point: raise them once a 429 is classified
 * retryable, and revisit them against the account's real throughput.
 *
 * Token bucket over fixed window because a tick that drains a backlog should be
 * able to burst, and then settle back to the sustained rate, instead of either
 * stalling at a window boundary or sustaining the burst rate forever.
 *
 * Capacity above the rate is what lets an idle number catch up: a number that
 * sent nothing for a minute may spend its accumulated budget at once.
 */
export const rateLimiter = new RateLimiter(components.rateLimiter, {
  telnyxSend: { kind: "token bucket", rate: 5, period: SECOND, capacity: 10 },
  telnyxSendPerNumber: { kind: "token bucket", rate: 1, period: SECOND, capacity: 3 },
});

/** The outcome of asking for send capacity, as the runner needs to read it. */
export interface SendCapacity {
  ok: boolean;
  /** When capacity would next be available, or null when it is available now. */
  retryAfter: number | null;
}

/**
 * Claim capacity for one send, or explain when to come back.
 *
 * Both limits are checked before either is consumed. `limit()` consumes as it
 * evaluates, so consuming the account limit and then finding the per-number limit
 * exhausted would spend a token on a send that never happens, and the shortfall
 * would then throttle real traffic. Checking first costs one extra component
 * call per send and cannot race: the whole thing is one transaction, so nothing
 * can slip between the check and the consumption.
 *
 * A failed claim consumes nothing at all, which is what lets the caller treat a
 * refusal as "not yet" rather than as "this was attempted".
 *
 * Must be called from a mutation or query: the component reads and writes the
 * database, and actions have no `ctx.db`. The runner reaches it through an
 * internal mutation for that reason.
 */
export async function claimSendCapacity(
  ctx: MutationCtx,
  options: { fromNumber: string },
): Promise<SendCapacity> {
  const account = await rateLimiter.check(ctx, "telnyxSend");
  if (!account.ok) return { ok: false, retryAfter: account.retryAfter };

  const perNumber = await rateLimiter.check(ctx, "telnyxSendPerNumber", {
    key: options.fromNumber,
  });
  if (!perNumber.ok) return { ok: false, retryAfter: perNumber.retryAfter };

  await rateLimiter.limit(ctx, "telnyxSend");
  await rateLimiter.limit(ctx, "telnyxSendPerNumber", { key: options.fromNumber });
  return { ok: true, retryAfter: null };
}
