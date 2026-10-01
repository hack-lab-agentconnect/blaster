import type { TokenSet } from "@blaster/core/twenty/oauth";

export interface PublicAuthConfig {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export interface OperatorSession {
  tokens: TokenSet;
  obtainedAtMs: number;
}

export interface PendingFlow {
  verifier: string;
  state: string;
}

/**
 * Who is signed in, as reported by `GET /api/auth/me`.
 *
 * Member fields are present only when the token resolved to a workspace
 * member; `memberName` is what the UI greets the operator with.
 */
export interface OperatorIdentity {
  username: string | null;
  scope: string | null;
  memberResolved: boolean;
  resolvedVia: string | null;
  applicationToken: boolean;
  workspaceMemberId?: string;
  memberName?: string;
  memberEmail?: string;
}
