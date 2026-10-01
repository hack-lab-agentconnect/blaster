/**
 * The Bark server to talk to.
 *
 * Defaults to the public server, overridable for a self-hosted instance. The
 * trailing slash is stripped here so the caller's `${server}/push` cannot produce
 * a double slash, which some proxies answer with a redirect rather than the
 * notification.
 */
export function getBarkServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.BARK_SERVER_URL || "https://api.day.app").trim();
  return raw.replace(/\/+$/, "");
}
