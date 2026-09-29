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
