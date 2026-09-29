/**
 * Throwaway end-to-end check: a guarded Twenty behind a stub, the real Hono
 * API in front of it, and the OAuth routes exercised over HTTP.
 *
 * Not a committed test. It exists to prove the whole wall path works in the
 * running service, not just in a unit test: API -> Basic -> guard -> discovery,
 * then code exchange, then introspection of the operator's bearer token.
 */
import { createServer } from "node:http";

const GUARD = { user: "twenty", password: "guard-secret" };
const seen: Array<{ path: string; auth: string | null }> = [];

const twenty = createServer((req, res) => {
  const auth = req.headers.authorization ?? null;
  seen.push({ path: req.url ?? "", auth });
  const guarded = (req.url ?? "").startsWith("/rest") || (req.url ?? "").startsWith("/graphql");
  if (!guarded && auth !== `Basic ${Buffer.from(`${GUARD.user}:${GUARD.password}`).toString("base64")}`) {
    res.writeHead(401, { "www-authenticate": 'Basic realm="guard"' });
    res.end("401 Authorization Required");
    return;
  }
  if ((req.url ?? "").startsWith("/.well-known/oauth-authorization-server")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        introspection_endpoint: `${base}/oauth/introspect`,
        registration_endpoint: `${base}/oauth/register`,
      }),
    );
    return;
  }
  if ((req.url ?? "").startsWith("/oauth/token")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: "op-access", refresh_token: "op-refresh", expires_in: 3600, scope: "api profile" }));
    return;
  }
  if ((req.url ?? "").startsWith("/oauth/introspect")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ active: true, username: "operator@inferencesaver.com", scope: "api profile" }));
    return;
  }
  res.writeHead(404).end();
});

let base = "";
await new Promise<void>((resolve) => twenty.listen(0, () => resolve()));
const address = twenty.address();
if (address && typeof address === "object") base = `http://127.0.0.1:${address.port}`;

process.env.TWENTY_BASE_URL = base;
process.env.TWENTY_OAUTH_CLIENT_ID = "public-client";
process.env.TWENTY_OAUTH_REDIRECT_URI = "http://localhost:5173/callback";
process.env.TWENTY_OAUTH_SCOPE = "api profile";
process.env.TWENTY_OAUTH_CLIENT_SECRET = "";
process.env.TWENTY_BASIC_USER = GUARD.user;
process.env.TWENTY_BASIC_PASSWORD = GUARD.password;
process.env.PORT = "4199";

const { default: app } = await import("./apps/api/src/index.ts");
const listener = app.fetch.bind(app);
const call = async (path: string, init?: RequestInit) => {
  const res = await listener(new Request(`http://localhost:4199${path}`, init));
  return { status: res.status, body: await res.json() };
};

const config = await call("/api/auth/config");
console.log("GET /api/auth/config ->", config.status, JSON.stringify(config.body));

const token = await call("/api/auth/token", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: "code-123", verifier: "verifier-123" }),
});
console.log("POST /api/auth/token ->", token.status, JSON.stringify(token.body));

const me = await call("/api/auth/me", { headers: { Authorization: "Bearer op-access" } });
console.log("GET /api/auth/me ->", me.status, JSON.stringify(me.body));

const refresh = await call("/api/auth/refresh", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refreshToken: "op-refresh" }),
});
console.log("POST /api/auth/refresh ->", refresh.status, JSON.stringify(refresh.body));

console.log("\n--- what the guard saw ---");
for (const entry of seen) {
  console.log(`${entry.path}  auth=${entry.auth === null ? "none" : entry.auth.slice(0, 12) + "..."}`);
}
twenty.close();
