/**
 * The operator gate for the inbox routes.
 *
 * Convex has no `auth.config.ts` here, so `listConversations` and
 * `conversationMessages` are public functions: anyone holding the deployment
 * URL can call them directly. The HTTP route is therefore not a convenience
 * wrapper, it is the only place authorisation happens, and these routes carry
 * prospect phone numbers and message bodies.
 *
 * A token is accepted when Twenty itself says it is live, which is the same
 * check `GET /api/auth/me` makes. Twenty publishes no JWKS, so introspection
 * is the documented way to validate a token rather than decoding it locally
 * and trusting the claims.
 *
 * The gate fails closed: no OAuth config means 503, not an open door, because
 * "we could not check" and "allowed" must never be the same answer.
 */

import type { Context, MiddlewareHandler } from "hono";
import { checkOperatorToken, loadOAuthConfig } from "../../twenty/oauth/index.ts";

export type OperatorInfo = { username: string | null; scope: string | null };

async function operatorFromRequest(c: Context): Promise<OperatorInfo | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const config = loadOAuthConfig();
  if (!config) return null;
  const result = await checkOperatorToken(config, token);
  return result.active ? { username: result.username, scope: result.scope } : null;
}

/** Require a live operator token. Unauthenticated callers get 401. */
export const requireOperator: MiddlewareHandler = async (c, next) => {
  if (!loadOAuthConfig()) {
    return c.json(
      { error: "Operator sign-in is not configured on this deployment" },
      503,
    );
  }
  let operator: OperatorInfo | null;
  try {
    operator = await operatorFromRequest(c);
  } catch (error) {
    return c.json(
      {
        error: "Could not validate the operator token",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
  if (!operator) {
    return c.json({ error: "A live operator token is required" }, 401);
  }
  c.set("operator", operator);
  await next();
};
