/**
 * Turning a request into the actor its Twenty writes should carry.
 *
 * Attribution is best-effort by design. A write with no actor still succeeds, it
 * just gets Twenty's API actor — the behaviour every write had before this
 * existed. That is deliberate: attribution is metadata on a record, and a caller
 * that cannot be attributed (a Convex action, a scheduled sync, the CLI, any
 * surface without a signed-in operator) must not be blocked from writing.
 *
 * So this returns null rather than throwing when there is no member, and it also
 * returns a usable actor when the member lookup fails, falling back to whatever
 * name the request already carried. Losing a display name is a cosmetic problem;
 * failing the write would be a functional one.
 */

import type { TwentyClient } from "../client/index.ts";
import { findWorkspaceMember } from "../workspaceMember/index.ts";
import type { ActorIdentity, ActorPayload, WriteActor } from "./types.ts";

export type { ActorIdentity, ActorPayload, WriteActor };

/**
 * Member id to display name, for the process.
 *
 * Member names change rarely and every write in a burst resolves the same one,
 * so this saves a `workspaceMembers` read per record. Bounded so a long-lived
 * process cannot grow it without limit.
 */
const MAX_CACHED_NAMES = 500;
const memberNameCache = new Map<string, string>();

function cacheName(memberRef: string, name: string): void {
  if (memberNameCache.size >= MAX_CACHED_NAMES) {
    const oldest = memberNameCache.keys().next();
    if (!oldest.done) memberNameCache.delete(oldest.value);
  }
  memberNameCache.set(memberRef, name);
}

/** Forget a cached name, for tests and for an explicit refresh after a rename. */
export function forgetMemberName(memberRef: string): void {
  memberNameCache.delete(memberRef);
}

/**
 * The actor a write on behalf of `identity` should carry, or null when there is
 * no member to attribute.
 *
 * The member id is required and is never invented: without one there is nothing
 * for Twenty to point `createdBy` at, so an actor without a member id would be a
 * different anonymous actor wearing a name.
 */
export async function resolveActor(
  client: TwentyClient,
  identity: ActorIdentity,
): Promise<WriteActor | null> {
  const memberRef = identity.workspaceMemberId?.trim() || null;
  if (!memberRef) return null;

  let name = memberNameCache.get(memberRef);
  if (name === undefined) {
    name = await displayNameFor(client, memberRef, identity);
    cacheName(memberRef, name);
  }

  const createdBy: ActorPayload = { source: "API", workspaceMemberId: memberRef, name };
  return { createdBy };
}

/**
 * Prefer Twenty's own name for the member, then the request's, then the id.
 *
 * A failure to ask Twenty is swallowed: the id is already enough to attribute
 * the record, and a member whose row was deleted still deserves their writes.
 */
async function displayNameFor(
  client: TwentyClient,
  memberRef: string,
  identity: ActorIdentity,
): Promise<string> {
  const fallback = identity.name?.trim() || identity.email?.trim() || memberRef;
  try {
    const member = await findWorkspaceMember(client, {
      workspaceMemberId: memberRef,
      userId: identity.userId,
      email: identity.email,
    });
    if (!member) return fallback;
    const full = `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim();
    return full || member.userEmail?.trim() || fallback;
  } catch {
    return fallback;
  }
}
