/**
 * Reading Twenty's `workspaceMembers`, so a write can name the person who made it.
 *
 * `workspaceMembers` is readable over the same REST surface as every other
 * object, so this needs no database access and no second credential — the
 * workspace API key the client already carries is enough.
 *
 * Resolution order is strongest-identifier-first: `workspaceMemberId` is an exact
 * primary key, `userId` is what an OAuth `sub` resolves to, and email is the last
 * resort because it is the only one a human can retype. Email is compared
 * case-insensitively, since the two systems do not agree on case.
 */

import type { TwentyClient, TwentyRecord } from "../client/index.ts";
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
 * Sub -> member id, for the process.
 *
 * Every authenticated request resolves the same few operators, and each
 * resolution otherwise costs a full `workspaceMembers` read. Keyed by `sub`
 * because that is stable across token refreshes, whereas an access token is not.
 */
const MAX_CACHED_MEMBERS = 500;
const memberRefCache = new Map<string, string>();

/** Forget a cached resolution, for tests and after a membership change. */
export function forgetResolvedMember(sub: string): void {
  memberRefCache.delete(sub);
}

/**
 * Resolve an OAuth identity to a member, with a process cache.
 *
 * Returns null when the identity names no member, or when Twenty cannot be
 * reached. Both mean the same thing to a caller — attribute nothing — and neither
 * is allowed to fail the request that asked, because attribution is metadata on a
 * record rather than a precondition for writing one.
 */
export async function resolveMemberIdentity(
  client: TwentyClient,
  input: { sub?: string | null; email?: string | null },
): Promise<ResolvedMember | null> {
  const sub = input.sub?.trim() || null;
  const email = input.email?.trim() || null;
  if (!sub && !email) return null;

  if (sub) {
    const cached = memberRefCache.get(sub);
    if (cached) {
      return { workspaceMemberId: cached, userId: sub, email, name: null };
    }
  }

  let member: WorkspaceMemberRecord | null;
  try {
    member = await findWorkspaceMember(client, { userId: sub, email });
  } catch {
    // Twenty was unreachable or the object was refused. Attribution is optional,
    // so this degrades to "no member" instead of surfacing as a failed request.
    return null;
  }
  if (!member) return null;

  if (sub) cacheMemberRef(sub, member.id);
  return {
    workspaceMemberId: member.id,
    userId: member.userId ?? sub,
    email: member.userEmail ?? email,
    name: `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim() || null,
  };
}

/** Insert, evicting the oldest entry once the cache is full. */
function cacheMemberRef(sub: string, memberId: string): void {
  if (memberRefCache.size >= MAX_CACHED_MEMBERS) {
    const oldest = memberRefCache.keys().next();
    if (!oldest.done) memberRefCache.delete(oldest.value);
  }
  memberRefCache.set(sub, memberId);
}
