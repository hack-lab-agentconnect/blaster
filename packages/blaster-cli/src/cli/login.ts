/**
 * `blaster login` / `logout` / `whoami` —” operator sign-in for the CLI.
 *
 * Identity comes from Twenty itself (Twenty is the OAuth provider); there is
 * no separate identity service. The flow reuses the proven loopback shape:
 *
 * 1. PKCE browser flow (default): the CLI generates a state nonce and an
 *    S256 challenge, opens `<webUrl>/cli?state=—¦&code_challenge=—¦&
 *    exchange=—¦`, and serves a one-shot loopback exchange on 127.0.0.1. The
 *    web app signs the operator in against Twenty and POSTs the Twenty
 *    tokens back. The CLI accepts the exchange only when state and challenge
 *    echo this run, binding it to the terminal.
 * 2. Paste path (`--token <access-token>`): same validation and storage,
 *    for headless terminals.
 *
 * Exactly one confidential OAuth client exists —” the Hono API's, whose
 * secret never leaves the server. The CLI validates tokens through
 * `GET /api/auth/me` and rotates them through `POST /api/auth/refresh`,
 * so devices never hold the client secret. Sessions live in gitignored
 * `.blaster/` (config.json + sessions.json): never in env vars, never
 * printed in full.
 */

import {
  loadSessionHome,
  removeSessionRecord,
  saveSessionRecord,
  type SessionConfig as HomeConfig,
  type SessionRecord,
} from "@blaster/core";
import { spawn } from "node:child_process";
import http from "node:http";
import {
  codeChallengeForVerifier,
  generateCodeVerifier,
  generateState,
  isTokenExpired,
} from "@blaster/core/twenty/oauth";

export const LOGIN_USAGE = `Usage: blaster login [--web-url <url>] [--api-url <url>] [--token <tok>] [--json]

  Sign in via the web app (Twenty OAuth through the browser) or paste a
  Twenty access token. The token is validated, then stored in
  .blaster/sessions.json.`;
export const LOGOUT_USAGE = "Usage: blaster logout [--api-url <url>] [--json]";
export const WHOAMI_USAGE = "Usage: blaster whoami [--api-url <url>] [--json]";

const DEFAULT_WEB_URL = "http://localhost:5173";
const DEFAULT_API_URL = "http://localhost:4180";
const EXCHANGE_TIMEOUT_MS = 120_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16_384;

/** Never print a token in full; show first/last four with the middle masked. */
export function maskSecret(token: string): string {
  if (token.length <= 12) return "***";
  return `${token.slice(0, 4)}—¦${token.slice(-4)}`;
}

/** Accept http(s) origins only. Pure. */
export function validateHttpUrl(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return "URL is required";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "URL must use http or https";
    }
  } catch {
    return "URL must be an absolute URL";
  }
  return undefined;
}

/**
 * Build the web app URL the CLI opens: /cli carrying this run's
 * state/challenge and the loopback exchange URL the browser posts back to.
 */
export function buildAuthorizeUrl(webUrl: string, state: string, challenge: string, exchangeUrl: string): string {
  const url = new URL("/cli", webUrl);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("exchange", exchangeUrl);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Session store (.blaster/)
// ---------------------------------------------------------------------------

/**
 * The store itself now lives in `@blaster/core`, so the MCP server can read the
 * operator's own session instead of inventing a second credential or a second
 * copy of this file format. These names stay exported because the CLI's other
 * commands and its tests already use them.
 */
export type { SessionConfig as HomeConfig, SessionRecord } from "@blaster/core";

export function loadHome(root: string): {
  config: HomeConfig;
  sessions: Record<string, SessionRecord>;
} {
  return loadSessionHome(root);
}

export function saveSession(root: string, record: SessionRecord, config: HomeConfig): void {
  saveSessionRecord(root, record, config);
}

export function removeSession(root: string, apiUrl: string): boolean {
  return removeSessionRecord(root, apiUrl);
}

/** API resolution: flag, then .blaster config, then env, then local default. */
export function resolveApiUrl(flag: string | undefined, root = process.cwd()): string {
  if (flag) return flag;
  const fromEnv = process.env.BLASTER_API_URL;
  if (fromEnv) return fromEnv;
  return loadHome(root).config.apiUrl ?? DEFAULT_API_URL;
}

export function resolveWebUrl(flag: string | undefined, root = process.cwd()): string {
  if (flag) return flag;
  const fromEnv = process.env.BLASTER_WEB_URL;
  if (fromEnv) return fromEnv;
  return loadHome(root).config.webUrl ?? DEFAULT_WEB_URL;
}

// ---------------------------------------------------------------------------
// Loopback exchange server (receives Twenty tokens from the web page)
// ---------------------------------------------------------------------------

export interface ExchangeRequest {
  state: string;
  code_challenge: string;
  access_token: string;
  refresh_token: string | null;
  expires_in: number | null;
}

export type ExchangeResult =
  | { ok: true; session: Omit<SessionRecord, "username" | "apiUrl" | "loggedInAt"> }
  | { ok: false; error: "timed out" | "invalid exchange" };

function isValidTokenField(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_TOKEN_LENGTH;
}

/**
 * One-shot loopback exchange server. Accepts a single valid POST to
 * /exchange and then stops serving; a timeout resolves as `timed out`.
 * Binds 127.0.0.1 only. The state/challenge echo binds the POST to the run
 * that opened the browser; the tokens themselves were minted by Twenty.
 */
export function runExchangeServer(options: {
  state: string;
  challenge: string;
  timeoutMs?: number;
}): {
  url: Promise<string>;
  result: Promise<ExchangeResult>;
  close: () => void;
} {
  const timeoutMs = options.timeoutMs ?? EXCHANGE_TIMEOUT_MS;
  let server: http.Server | undefined;
  let finished = false;
  let resolveResult: ((result: ExchangeResult) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = (result: ExchangeResult) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    resolveResult?.(result);
    const s = server;
    if (s) {
      s.removeAllListeners("request");
      s.closeAllConnections?.();
      s.close();
    }
  };

  const url = new Promise<string>((resolve, reject) => {
    server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
    server.on("error", (error) => reject(error));
  });

  const result = new Promise<ExchangeResult>((resolve) => {
    resolveResult = resolve;
    timer = setTimeout(() => finish({ ok: false, error: "timed out" }), timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const validate = (payload: Record<string, unknown>): string | undefined => {
      if (payload.state !== options.state) return "invalid exchange";
      if (payload.code_challenge !== options.challenge) return "invalid exchange";
      if (!isValidTokenField(payload.access_token)) return "invalid exchange";
      const refresh = payload.refresh_token;
      if (refresh !== null && refresh !== undefined && !isValidTokenField(refresh)) {
        return "invalid exchange";
      }
      const expires = payload.expires_in;
      if (expires !== null && expires !== undefined && typeof expires !== "number") {
        return "invalid exchange";
      }
      return undefined;
    };

    server?.on("request", (req, res) => {
      const send = (status: number, body: string) => {
        if (res.writableEnded) return;
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          // The web app posts cross-origin (its origin to 127.0.0.1);
          // without these the browser blocks the response.
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end(body);
      };

      if (req.method === "OPTIONS" && req.url === "/exchange") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }
      if (finished) {
        send(409, JSON.stringify({ ok: false, error: "login already complete" }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/exchange") {
        send(404, JSON.stringify({ ok: false, error: "not found" }));
        return;
      }

      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          send(413, JSON.stringify({ ok: false, error: "payload too large" }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (finished) return;
        let payload: unknown;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          send(400, JSON.stringify({ ok: false, error: "invalid exchange" }));
          return;
        }
        const problem = validate(payload as Record<string, unknown>);
        if (problem) {
          send(400, JSON.stringify({ ok: false, error: problem }));
          return;
        }
        const body = payload as {
          access_token: string;
          refresh_token?: string | null;
          expires_in?: number | null;
        };
        send(200, JSON.stringify({ ok: true }));
        finish({
          ok: true,
          session: {
            accessToken: body.access_token,
            refreshToken: body.refresh_token ?? null,
            expiresIn: body.expires_in ?? null,
            obtainedAtMs: Date.now(),
          },
        });
      });
      req.on("error", () => undefined);
    });
  });

  return {
    url,
    result,
    close: () => finish({ ok: false, error: "timed out" }),
  };
}

function openBrowser(url: string): boolean {
  try {
    const platform = process.platform;
    let command: string;
    let args: string[];
    if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token validation + refresh through the Hono API (holds the client secret)
// ---------------------------------------------------------------------------

export interface OperatorIdentity {
  username: string | null;
  scope: string | null;
}

export type ValidationResult =
  | { ok: true; identity: OperatorIdentity }
  | { ok: false; kind: "config" | "auth" | "transport"; message: string };

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Validate an access token via the API, which introspects against Twenty.
 * Success proves the token is live and carries the operator's identity.
 * The token itself never appears in any message.
 */
export async function validateSessionToken(apiUrl: string, accessToken: string): Promise<ValidationResult> {
  if (accessToken.trim() === "") {
    return { ok: false, kind: "config", message: "No session token." };
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    return { ok: false, kind: "transport", message: error instanceof Error ? error.message : String(error) };
  }
  if (response.status === 401) {
    return { ok: false, kind: "auth", message: "The API rejected the session token" };
  }
  if (!response.ok) {
    return { ok: false, kind: "transport", message: `API answered ${response.status}` };
  }
  const body = await readJson(response);
  return {
    ok: true,
    identity: {
      username: typeof body.username === "string" ? body.username : null,
      scope: typeof body.scope === "string" ? body.scope : null,
    },
  };
}

async function refreshSessionToken(apiUrl: string, refreshToken: string): Promise<ValidationResult & { tokens?: {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
} }> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/+$/, "")}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch (error) {
    return { ok: false, kind: "transport", message: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    return { ok: false, kind: "auth", message: "The stored session cannot be refreshed. Sign in again." };
  }
  const body = await readJson(response);
  const tokens = body.tokens as { access_token?: unknown; accessToken?: unknown; refresh_token?: unknown; refreshToken?: unknown; expires_in?: unknown; expiresIn?: unknown } | undefined;
  const accessToken = tokens?.accessToken ?? tokens?.access_token;
  if (typeof accessToken !== "string") {
    return { ok: false, kind: "transport", message: "Refresh returned no access token" };
  }
  const nextRefresh = tokens?.refreshToken ?? tokens?.refresh_token;
  const expiresIn = tokens?.expiresIn ?? tokens?.expires_in;
  // Validate the rotated token before trusting it.
  const validation = await validateSessionToken(apiUrl, accessToken);
  if (!validation.ok) return validation;
  return {
    ...validation,
    tokens: {
      accessToken,
      refreshToken: typeof nextRefresh === "string" ? nextRefresh : refreshToken,
      expiresIn: typeof expiresIn === "number" ? expiresIn : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Commands (blaster CLI style: return exit code, print human or JSON)
// ---------------------------------------------------------------------------

function flagValue(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export async function loginMain(
  flags: Map<string, string | boolean>,
  json: boolean,
  root = process.cwd(),
): Promise<number> {
  const webUrlArg = flagValue(flags, "web-url");
  const apiUrlArg = flagValue(flags, "api-url") ?? flagValue(flags, "deployment");
  const pasted = flagValue(flags, "token");

  for (const [name, value] of [["--web-url", webUrlArg], ["--api-url", apiUrlArg]] as const) {
    if (value !== undefined) {
      const issue = validateHttpUrl(value);
      if (issue) {
        console.error(`blaster login: ${name} ${issue.toLowerCase()}\n${LOGIN_USAGE}`);
        return 1;
      }
    }
  }
  const apiUrl = resolveApiUrl(apiUrlArg, root);

  let partial: Omit<SessionRecord, "username" | "apiUrl" | "loggedInAt">;
  let source: "browser" | "paste";
  if (pasted) {
    partial = { accessToken: pasted, refreshToken: null, expiresIn: null, obtainedAtMs: Date.now() };
    source = "paste";
  } else {
    const webUrl = resolveWebUrl(webUrlArg, root);
    // The verifier never leaves this process; the challenge below commits to
    // it, so an intercepted exchange POST is useless without the verifier.
    const challenge = await codeChallengeForVerifier(generateCodeVerifier());
    const state = generateState();

    const exchange = runExchangeServer({ state, challenge });
    let exchangeUrl: string;
    try {
      exchangeUrl = `${await exchange.url}/exchange`;
    } catch (error) {
      exchange.close();
      console.error(`blaster login: could not start the local exchange server: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const authorize = buildAuthorizeUrl(webUrl, state, challenge, exchangeUrl);
    try {
      console.log(`Opening browser: ${authorize}`);
      if (!openBrowser(authorize)) {
        console.log(`Could not open a browser automatically. Open this URL manually: ${authorize}`);
      }
      console.log("Waiting for sign-in to complete—¦");
      const outcome = await exchange.result;
      if (!outcome.ok) {
        console.error(
          outcome.error === "timed out"
            ? "blaster login: sign-in timed out before the browser completed the exchange."
            : "blaster login: the browser could not complete the exchange.",
        );
        return 1;
      }
      partial = outcome.session;
      source = "browser";
    } finally {
      exchange.close();
    }
  }

  const validation = await validateSessionToken(apiUrl, partial.accessToken);
  if (!validation.ok) {
    console.error(
      validation.kind === "auth"
        ? "blaster login: the API rejected the session token. Sign in again and re-run blaster login."
        : `blaster login: ${validation.message}`,
    );
    return 1;
  }

  saveSession(
    root,
    {
      ...partial,
      username: validation.identity.username,
      apiUrl,
      loggedInAt: new Date().toISOString(),
    },
    { apiUrl },
  );
  const masked = maskSecret(partial.accessToken);
  console.log(
    json
      ? JSON.stringify(
        { ok: true, command: "login", source, apiUrl, username: validation.identity.username, masked },
        null,
        2,
      )
      : `Signed in${validation.identity.username ? ` as ${validation.identity.username}` : ""}. Stored Twenty session for ${apiUrl} (.blaster/sessions.json, ${masked}).`,
  );
  return 0;
}

export async function logoutMain(
  flags: Map<string, string | boolean>,
  json: boolean,
  root = process.cwd(),
): Promise<number> {
  const apiUrlArg = flagValue(flags, "api-url") ?? flagValue(flags, "deployment");
  const home = loadHome(root);
  const stored = Object.values(home.sessions);
  const only = stored.length === 1 ? stored[0] : undefined;
  const target = apiUrlArg ?? only?.apiUrl;
  if (!target) {
    console.error(
      stored.length === 0
        ? "blaster logout: not signed in anywhere."
        : `blaster logout: signed in to ${stored.map((s) => s.apiUrl).join(", ")}. Pass --api-url <url> to pick one.`,
    );
    return 1;
  }
  if (!removeSession(root, target)) {
    console.error(`blaster logout: no stored session for ${target}.`);
    return 1;
  }
  console.log(
    json
      ? JSON.stringify({ ok: true, command: "logout", apiUrl: target }, null, 2)
      : `Signed out of ${target}.`,
  );
  return 0;
}

/**
 * Resolve a stored session to a live access token, refreshing once when the
 * stored one is expired. Returns null with an explanatory message when the
 * operator must sign in again.
 */
async function liveAccessToken(
  root: string,
  record: SessionRecord,
): Promise<{ ok: true; record: SessionRecord } | { ok: false; message: string }> {
  if (!isTokenExpired(record.obtainedAtMs, record.expiresIn)) {
    const validation = await validateSessionToken(record.apiUrl, record.accessToken);
    if (validation.ok) return { ok: true, record };
    if (validation.kind !== "auth" || !record.refreshToken) {
      return { ok: false, message: "The stored session was rejected. Run `blaster login` to refresh." };
    }
  }
  if (!record.refreshToken) {
    return { ok: false, message: "The stored session expired and has no refresh token. Run `blaster login` again." };
  }
  const rotated = await refreshSessionToken(record.apiUrl, record.refreshToken);
  if (!rotated.ok || !rotated.tokens) {
    return { ok: false, message: "The stored session cannot be refreshed. Run `blaster login` again." };
  }
  const next: SessionRecord = {
    ...record,
    ...rotated.tokens,
    username: rotated.identity.username,
    obtainedAtMs: Date.now(),
    loggedInAt: record.loggedInAt,
  };
  saveSession(root, next, { apiUrl: record.apiUrl });
  return { ok: true, record: next };
}

export async function whoamiMain(
  flags: Map<string, string | boolean>,
  json: boolean,
  root = process.cwd(),
): Promise<number> {
  const apiUrlArg = flagValue(flags, "api-url") ?? flagValue(flags, "deployment");
  const home = loadHome(root);
  const stored = Object.values(home.sessions);
  const record = apiUrlArg ? home.sessions[apiUrlArg] : stored.length === 1 ? stored[0] : undefined;
  if (!record) {
    console.error(
      stored.length === 0
        ? "blaster whoami: not signed in. Run `blaster login` to sign in."
        : `blaster whoami: signed in to ${stored.map((s) => s.apiUrl).join(", ")}. Pass --api-url <url> to pick one.`,
    );
    return 1;
  }
  const live = await liveAccessToken(root, record);
  if (!live.ok) {
    if (json) {
      console.log(JSON.stringify({ ok: false, command: "whoami", apiUrl: record.apiUrl, error: live.message }, null, 2));
    } else {
      console.error(`blaster whoami: ${live.message}`);
    }
    return 1;
  }
  const masked = maskSecret(live.record.accessToken);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: "whoami",
          apiUrl: live.record.apiUrl,
          username: live.record.username,
          masked,
          loggedInAt: live.record.loggedInAt,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      `Signed in to ${live.record.apiUrl}${live.record.username ? ` as ${live.record.username}` : ""} since ${live.record.loggedInAt} (${masked}). Session is valid.`,
    );
  }
  return 0;
}
