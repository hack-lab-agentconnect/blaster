import type { OAuthServerConfig } from "../types.ts";

/** Read the server-side OAuth config from env. Pure: null when incomplete. */
export function loadOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthServerConfig | null {
  const baseUrl = env.TWENTY_BASE_URL;
  const clientId = env.TWENTY_OAUTH_CLIENT_ID;
  const redirectUri = env.TWENTY_OAUTH_REDIRECT_URI;
  if (!baseUrl || !clientId || !redirectUri) return null;
  const basicUser = env.TWENTY_BASIC_USER;
  const basicPassword = env.TWENTY_BASIC_PASSWORD;
  // A public PKCE client is registered without a secret, and .env.example
  // spells that as an empty value. Normalising it to null here is what keeps
  // `client_secret=` off the token request instead of relying on a truthiness
  // check three layers down.
  const clientSecret = env.TWENTY_OAUTH_CLIENT_SECRET?.trim();
  return {
    baseUrl,
    clientId,
    clientSecret: clientSecret ? clientSecret : null,
    redirectUri,
    scope: env.TWENTY_OAUTH_SCOPE ?? "api profile",
    // Half a credential is not a credential: an unset password means no gate
    // is declared, not a guard that will reject everything.
    basicAuth: basicUser && basicPassword ? { user: basicUser, password: basicPassword } : null,
  };
}
