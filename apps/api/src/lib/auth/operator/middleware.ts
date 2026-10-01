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
 * Introspection establishes that a token is live, but its `sub` is the
 * *application* id and names nobody. The person is in the access token's own
 * claims, so they are read from there and resolved against `workspaceMembers`.
 * Getting this backwards is silent: sign-in works, `/api/auth/me` says active,
 * and no record is ever attributed. See docs/identity.md.
 *
 * An unresolved member is not fatal. The request is still authenticated, and
 * refusing it would lock out every read route on a deployment whose proxy needs
 * fixing. It is instead reported: `/api/auth/me` sets `memberResolved: false`,
 * and `applicationToken: true` when the token names no user at all, which is
 * the signature of a misconfigured auth-guard rather than of a non-member.
 */

import type { Context, MiddlewareHandler } from "hono";
import {
  TwentyClient,
  decodeJwtPayload,
  resolveActor,
  resolveMemberIdentity,
  type ActorIdentity,
  type ResolvedMember,
  type TwentyAccessTokenClaims,
  type WriteActor,
} from "@blaster/core";
import { checkOperatorToken, loadOAuthConfig } from "../../twenty/oauth/index.ts";

export type { ActorIdentity, WriteActor };

export interface OperatorInfo {
  username: string | null;
  scope: string | null;
  /** The member this token belongs to, or null when it resolved to none. */
  member: ResolvedMember | null;
  /**
   * The access token's claims, kept only so `/api/auth/me` can explain an
   * unresolved member. Not part of the operator's identity.
   */
  tokenClaims: TwentyAccessTokenClaims | null;
}

/** A workspace client, or null when Twenty is not configured for this process. */
function twentyClientOrNull(): TwentyClient | null {
  if (!process.env.TWENTY_BASE_URL || !process.env.TWENTY_API_KEY) return null;
  return new TwentyClient();
}

/**
 * The claims a live token carries, or null when it is not a JWT.
 *
 * Never throws: a token that cannot be decoded resolves no member, which the
 * caller already handles. The alternative — failing the request — would turn an
 * opaque token format into a lockout.
 */
function claimsOf(accessToken: string): TwentyAccessTokenClaims | null {
  try {
    return decodeJwtPayload<TwentyAccessTokenClaims>(accessToken);
  } catch {
    return null;
  }
}

async function resolveMember(
  introspection: { claims?: Record<string, unknown>; email?: string | null },
  accessToken: string,
): Promise<{ member: ResolvedMember | null; claims: TwentyAccessTokenClaims | null }> {
  const client = twentyClientOrNull();
  const claims = claimsOf(accessToken);
  if (!client) return { member: null, claims };
  const member = await resolveMemberIdentity(client, {
    claims,
    introspectionClaims: introspection.claims,
  });
  return { member, claims };
}

async function operatorFromRequest(c: Context): Promise<OperatorInfo | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return null;
  const config = loadOAuthConfig();
  if (!config) return null;
  const result = await checkOperatorToken(config, token);
  if (!result.active) return null;
  const { member, claims } = await resolveMember(result, token);
  return { username: result.username, scope: result.scope, member, tokenClaims: claims };
}

/** Require a live operator token. Unauthenticated callers get 401. */
export const requireOperator: MiddlewareHandler = async (c, next) => {
  const route = `${c.req.method} ${c.req.path}`;
  if (!loadOAuthConfig()) {
    console.log(`[auth] ${route} -> 503 (operator sign-in not configured on this deployment)`);
    return c.json(
      { error: "Operator sign-in is not configured on this deployment" },
      503,
    );
  }
  let operator: OperatorInfo | null;
  try {
    operator = await operatorFromRequest(c);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`[auth] ${route} -> 502 (could not validate operator token: ${detail})`);
    return c.json(
      {
        error: "Could not validate the operator token",
        detail,
      },
      502,
    );
  }
  if (!operator) {
    console.log(`[auth] ${route} -> 401 (no live operator token)`);
    return c.json({ error: "A live operator token is required" }, 401);
  }
  const member = operator.member;
  console.log(
    `[auth] ${route} -> operator member=${member?.email ?? "UNRESOLVED"} via=${member?.resolvedVia ?? "none"}`,
  );
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
