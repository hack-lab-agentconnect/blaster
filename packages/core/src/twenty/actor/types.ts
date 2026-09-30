/**
 * The Actor Twenty stamps on a record it creates.
 *
 * Twenty attributes a write to whoever authenticated it. Blaster authenticates
 * as the workspace with `TWENTY_API_KEY`, so every record it creates is stamped
 * with the anonymous API actor — which is why records showed an API actor rather
 * than the operator whose session triggered the sync.
 *
 * `createdBy` is overridable on a write, and passing this payload is what fixes
 * that: the request is still authenticated as the API key, but names the member.
 *
 * `updatedBy` is not. Passing it is accepted and then recomputed by Twenty from
 * the authenticated caller, so it silently does nothing. That is why there is no
 * field for it here: an attribute that cannot be set is worse than an absent one,
 * because the type would promise something the API does not do. Attribution reads
 * `createdBy`.
 */
export interface ActorPayload {
  /** The API-key actor source, so Twenty keeps its own bookkeeping intact. */
  source: "API";
  /** The workspaceMember this write is attributed to. */
  workspaceMemberId: string;
  /** Human name, for the record's "created by" display. */
  name: string;
}

/** What a write may carry about who caused it. */
export interface WriteActor {
  createdBy?: ActorPayload;
}

/**
 * Who the current request belongs to, as far as we can tell.
 *
 * Deliberately permissive: any of these may be missing, and a missing one is not
 * an error. It means the caller had no member to attribute, not that attribution
 * failed.
 */
export interface ActorIdentity {
  /** Exact `workspaceMember` id, resolved from the access token. */
  workspaceMemberId?: string | null;
  /** Twenty's user id, from the token's `userId` claim. */
  userId?: string | null;
  email?: string | null;
  /** A display name the caller already had, used if Twenty cannot be asked. */
  name?: string | null;
}
