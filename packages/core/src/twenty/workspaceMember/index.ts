/**
 * Reading Twenty's `workspaceMembers`, so a write can name the person who made it.
 *
 * `workspaceMembers` is readable over the same REST surface as every other
 * object, so this needs no database access and no second credential — the
 * workspace API key the client already carries is enough.
 *
 * The identity comes from the access token's claims, not from introspection's
 * `sub`. Twenty reports `sub` as the *application* id, so resolving a member
 * from it matches nothing; see `resolveMemberIdentity` for the order that does
 * work. Email is compared case-insensitively, since the two systems do not
 * agree on case.
 */

import type { TwentyClient, TwentyRecord } from "../client/index.ts";
import { emailsFromClaims, type TwentyAccessTokenClaims } from "../oauth/index.ts";
import type { MemberLookup, ResolvedMember, WorkspaceMemberRecord } from "./types.ts";

export type { MemberLookup, ResolvedMember, WorkspaceMemberRecord };

const MEMBERS_OBJECT = "workspaceMembers";

/** Twenty caps a page at 200, which is far more members than a workspace holds. */
const MEMBER_PAGE_SIZE = 200;

function normalizeMember(raw: TwentyRecord): WorkspaceMemberRecord {
  const name =
    raw.name && typeof raw.name === "object" ? (raw.name as { firstName?: unknown; lastName?: unknown }) : {};
  return {
    ...raw,
    id: String(raw.id ?? ""),
    userId: typeof raw.userId === "string" ? raw.userId : null,
    userEmail: typeof raw.userEmail === "string" ? raw.userEmail : null,
    firstName: typeof name.firstName === "string" ? name.firstName : null,
    lastName: typeof name.lastName === "string" ? name.lastName : null,
    name: raw.name,
  };
}

/** Every member in the workspace, or an empty list when the object is absent. */
export async function listWorkspaceMembers(
  client: TwentyClient,
): Promise<WorkspaceMemberRecord[]> {
  const rows = await client.listAll<TwentyRecord>(MEMBERS_OBJECT, { limit: MEMBER_PAGE_SIZE });
  return rows.filter((row) => typeof row?.id === "string").map(normalizeMember);
}

/**
 * Find the member a write should be attributed to.
 *
 * Tries each identifier in order and returns the first match, so a request that
 * carries an exact member id never depends on the email lookup succeeding.
 * Returns null when nothing matches, which callers treat as "do not attribute"
 * rather than as an error.
 */
export async function findWorkspaceMember(
  client: TwentyClient,
  lookup: MemberLookup,
): Promise<WorkspaceMemberRecord | null> {
  const memberId = lookup.workspaceMemberId?.trim() || null;
  const userId = lookup.userId?.trim() || null;
  const email = lookup.email?.trim().toLowerCase() || null;
  if (!memberId && !userId && !email) return null;

  const members = await listWorkspaceMembers(client);

  if (memberId) {
    const byId = members.find((member) => member.id === memberId);
    if (byId) return byId;
  }
  if (userId) {
    const byUserId = members.find((member) => member.userId === userId);
    if (byUserId) return byUserId;
  }
  if (email) {
    const byEmail = members.find(
      (member) => member.userEmail?.toLowerCase() === email,
    );
    if (byEmail) return byEmail;
  }
  return null;
}

/**
 * Strongest-signal key -> member id, for the process.
 *
 * Every authenticated request resolves the same few operators, and each
 * resolution otherwise costs a full `workspaceMembers` read. Keyed by
 * `userWorkspaceId` or `userId` rather than by `sub`, for two reasons: `sub` is
 * the application id and would collapse every operator onto one cache entry, and
 * these claims are stable across token refreshes whereas an access token is not.
 */
const MAX_CACHED_MEMBERS = 500;
const memberRefCache = new Map<string, string>();

/** Forget a cached resolution, for tests and after a membership change. */
export function forgetResolvedMember(signal: string): void {
  memberRefCache.delete(signal);
}

/**
 * Resolve a live Twenty token to the workspace member behind it.
 *
 * Signals, most authoritative first:
 *
 *   1. `userWorkspaceId` from the access token — the member the token was minted
 *      in. Exact, and survives an email change.
 *   2. `userId` from the access token — the Twenty user, who can hold more than
 *      one member.
 *   3. any email-shaped introspection claim — a compatibility fallback, because
 *      which claim carries the address varies by deployment.
 *
 * `sub` is deliberately not a signal. Twenty puts the *application* id there, so
 * a lookup by it matches no user row and every record goes unattributed; that is
 * the bug this ordering exists to prevent.
 *
 * Returns null when nothing matches, or when Twenty cannot be reached. Both mean
 * the same thing to a caller — attribute nothing — and neither is allowed to fail
 * the request that asked, because attribution is metadata on a record rather than
 * a precondition for writing one. `resolvedVia` is the signal that worked, so a
 * caller can tell a genuine non-member apart from a lookup that never ran.
 */
export async function resolveMemberIdentity(
  client: TwentyClient,
  input: {
    /** The access token's payload, from `decodeJwtPayload`. */
    claims?: TwentyAccessTokenClaims | null;
    /** The raw introspection response, for the email fallback. */
    introspectionClaims?: Record<string, unknown> | null;
  },
): Promise<ResolvedMember | null> {
  const claims = input.claims ?? null;
  const memberRef = claims?.userWorkspaceId?.trim() || null;
  const userRef = claims?.userId?.trim() || null;
  const emails = emailsFromClaims(input.introspectionClaims);
  if (!memberRef && !userRef && emails.length === 0) return null;

  const cacheKey = memberRef ?? userRef;
  if (cacheKey) {
    const cached = memberRefCache.get(cacheKey);
    // A cache hit cannot report which claim matched, so it is attributed to the
    // signal that keyed it. That is exact rather than a guess: the entry exists
    // only because that very claim resolved to this member before.
    if (cached) {
      return {
        workspaceMemberId: cached,
        userId: userRef,
        email: emails[0] ?? null,
        name: null,
        resolvedVia: memberRef ? "jwt:userWorkspaceId" : "jwt:userId",
      };
    }
  }

  let member: WorkspaceMemberRecord | null = null;
  let via: ResolvedMember["resolvedVia"] = null;
  try {
    if (memberRef) {
      member = await findWorkspaceMember(client, { workspaceMemberId: memberRef });
      if (member) via = "jwt:userWorkspaceId";
    }
    if (!member && userRef) {
      member = await findWorkspaceMember(client, { userId: userRef });
      if (member) via = "jwt:userId";
    }
    for (const email of emails) {
      if (member) break;
      member = await findWorkspaceMember(client, { email });
      if (member) via = "claim:email";
    }
  } catch {
    // Twenty was unreachable or the object was refused. Attribution is optional,
    // so this degrades to "no member" instead of surfacing as a failed request.
    return null;
  }
  if (!member) return null;

  if (cacheKey) cacheMemberRef(cacheKey, member.id);
  return {
    workspaceMemberId: member.id,
    userId: member.userId ?? userRef,
    email: member.userEmail ?? emails[0] ?? null,
    name: `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || null,
    resolvedVia: via,
  };
}

/** Insert, evicting the oldest entry once the cache is full. */
function cacheMemberRef(signal: string, memberId: string): void {
  if (memberRefCache.size >= MAX_CACHED_MEMBERS) {
    const oldest = memberRefCache.keys().next();
    if (!oldest.done) memberRefCache.delete(oldest.value);
  }
  memberRefCache.set(signal, memberId);
}
