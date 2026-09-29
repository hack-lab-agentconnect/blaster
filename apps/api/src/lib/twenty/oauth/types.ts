import type { BasicCredentials } from "@blaster/core";

export interface OAuthServerConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  scope: string;
  /**
   * Basic-auth gate in front of the instance, when one is deployed. The
   * OAuth endpoints sit behind it; /rest and /graphql usually do not, so the
   * API key path never needs these.
   */
  basicAuth: BasicCredentials | null;
}
