/**
 * The `workspaceMember` row, flattened into the fields we actually read.
 *
 * Twenty returns the display name as a composite (`name: { firstName, lastName }`),
 * so the flattened pair is kept alongside it rather than replacing it.
 */
export interface WorkspaceMemberRecord {
  id: string;
  /** The Twenty user this member is, which is what an OAuth `sub` resolves to. */
  userId?: string | null;
  userEmail?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** The raw `name` composite as Twenty sent it. */
  name?: unknown;
  [key: string]: unknown;
}

/**
 * The ways one write can be attributed to a member.
 *
 * Resolution order is fixed and documented on `findWorkspaceMember`: the
 * strongest identifier present wins, and the weaker ones are only fallbacks.
 */
export interface MemberLookup {
  email?: string | null;
  userId?: string | null;
  workspaceMemberId?: string | null;
}

/**
 * A member resolved from an OAuth identity, ready to attribute a write to.
 *
 * `workspaceMemberId` is present exactly when resolution succeeded, so this is
 * the signal to branch on rather than the presence of the object.
 */
export interface ResolvedMember {
  workspaceMemberId: string;
  /** Twenty's user id, which is what an access token's `userId` claim is. */
  userId: string | null;
  email: string | null;
  name: string | null;
  /**
   * Which claim identified the member, for diagnosis.
   *
   * Reported rather than logged only: an application token resolves to nothing
   * at all, and the difference between "not a member" and "the token names no
   * human" is the difference between a permissions problem and a misconfigured
   * proxy. See docs/identity.md.
   */
  resolvedVia: "jwt:userWorkspaceId" | "jwt:userId" | "claim:email" | null;
}
