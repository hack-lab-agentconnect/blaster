/**
 * The operator gate for the authenticated routes, and the identity it carries.
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
 *
 * Introspection also yields the token's subject, which is a Twenty user id. That
 * is resolved to a `workspaceMember` here so the writes this request makes can be
 * attributed to the person rather than to the workspace API key. Resolution is
 * best-effort: a member that cannot be resolved leaves the request authorised but
 * unattributed, which is a metadata gap and not a reason to refuse it.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  TwentyClient,
  resolveActor,
  resolveMemberIdentity,
  type ActorIdentity,
  type ResolvedMember,
  type WriteActor,
} from "@blaster/core";
import { checkOperatorToken, loadOAuthConfig } from "../../twenty/oauth/index.ts";

export type { ActorIdentity, WriteActor };

export interface OperatorInfo {
  username: string | null;
  scope: string | null;
  /** The member this token belongs to, or null when it resolved to none. */
  member: ResolvedMember | null;
}

/** A workspace client, or null when Twenty is not configured for this process. */
function twentyClientOrNull(): TwentyClient | null {
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) return null;
  return new TwentyClient();
}

async function resolveMember(
  introspection: { sub: string | null; email: string | null; username: string | null },
): Promise<ResolvedMember | null> {
  const client = twentyClientOrNull();
  if (!client) return null;
  return resolveMemberIdentity(client, {
    sub: introspection.sub,
    // Twenty's introspection does not always echo the email, so the username is
    // the fallback: on a Twenty instance it is the member's login address.
    email: introspection.email ?? introspection.username,
  });
}

async function operatorFromRequest(c: Context): Promise<OperatorInfo | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const config = loadOAuthConfig();
  if (!config) return null;
  const result = await checkOperatorToken(config, token);
  if (!result.active) return null;
  return {
    username: result.username,
    scope: result.scope,
    member: await resolveMember(result),
  };
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

/**
 * Who the current request belongs to, for attribution.
 *
 * Empty when the route is unguarded or the member did not resolve, which callers
 * pass straight to `resolveActor` to get a null actor and an unattributed write.
 */
export function operatorIdentity(c: Context): ActorIdentity {
  const member = c.get("operator")?.member;
  return {
    workspaceMemberId: member?.workspaceMemberId ?? null,
    userId: member?.userId ?? null,
    email: member?.email ?? null,
    name: member?.name ?? c.get("operator")?.username ?? null,
  };
}

/**
 * The actor this request's Twenty writes should carry, or null when the request
 * has no resolved member.
 *
 * Returns null rather than throwing, including when Twenty is unreachable: the
 * write still happens, it just gets Twenty's API actor.
 */
export async function resolveOperatorActor(c: Context): Promise<WriteActor | null> {
  const client = twentyClientOrNull();
  if (!client) return null;
  return resolveActor(client, operatorIdentity(c));
}
