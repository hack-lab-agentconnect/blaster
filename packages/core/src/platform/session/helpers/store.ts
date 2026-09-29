/**
 * The operator session store, in one place.
 *
 * `.blaster/sessions.json` holds Twenty access and refresh tokens per API
 * origin, written by `blaster login`. It was owned by the CLI, which meant the
 * MCP server had no honest way to authenticate: it could re-implement the file
 * format, or read the API with a credential of its own, and both are worse than
 * sharing the operator's own session. Now the store lives here and the CLI
 * re-exports it, so `blaster inbox` and `blaster_list_conversations` present the
 * same identity to the API.
 *
 * The file holds live credentials and is gitignored (`.gitignore`, `.blaster/`).
 * It is read with the caller's `root` so it can be pointed elsewhere in tests
 * rather than reaching into the working directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SESSION_DIR = ".blaster";

export interface SessionRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  obtainedAtMs: number;
  username: string | null;
  apiUrl: string;
  loggedInAt: string;
}

export interface SessionConfig {
  apiUrl?: string;
  webUrl?: string;
}

export interface SessionHome {
  config: SessionConfig;
  sessions: Record<string, SessionRecord>;
}

const sessionDir = (root: string): string => join(root, SESSION_DIR);

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // A corrupt or unreadable store reads as "not signed in" rather than
    // crashing: the remedy is the same either way, and a crash here would look
    // like a bug in whatever the caller was doing.
    return null;
  }
}

function isSessionRecord(value: unknown): value is SessionRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionRecord>;
  return (
    typeof candidate.accessToken === "string" &&
    typeof candidate.apiUrl === "string" &&
    typeof candidate.obtainedAtMs === "number"
  );
}

export function loadSessionHome(root: string): SessionHome {
  const dir = sessionDir(root);
  const config = (readJsonFile(join(dir, "config.json")) ?? {}) as SessionConfig;
  const raw = readJsonFile(join(dir, "sessions.json")) ?? {};
  const sessions: Record<string, SessionRecord> = {};
  for (const [apiUrl, record] of Object.entries(raw)) {
    if (isSessionRecord(record)) sessions[apiUrl] = record;
  }
  return { config, sessions };
}

function writeSessionHome(root: string, config: SessionConfig, sessions: Record<string, SessionRecord>): void {
  const dir = sessionDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, "sessions.json"), `${JSON.stringify(sessions, null, 2)}\n`);
}

export function saveSessionRecord(
  root: string,
  record: SessionRecord,
  config: SessionConfig = {},
): void {
  const home = loadSessionHome(root);
  home.sessions[record.apiUrl] = record;
  writeSessionHome(root, { ...home.config, ...config }, home.sessions);
}

export function removeSessionRecord(root: string, apiUrl: string): boolean {
  const home = loadSessionHome(root);
  if (!home.sessions[apiUrl]) return false;
  delete home.sessions[apiUrl];
  writeSessionHome(root, home.config, home.sessions);
  return true;
}

/**
 * The session to authenticate with, and why it might be missing.
 *
 * The caller needs to tell "never signed in" apart from "signed in elsewhere",
 * because the remedies differ and a single vague message sends people looking in
 * the wrong place.
 */
export function resolveSession(
  root: string,
  apiUrl?: string,
): { session: SessionRecord } | { session: null; reason: "no-api" | "not-signed-in" } {
  const home = loadSessionHome(root);
  const target = apiUrl ?? home.config.apiUrl ?? Object.keys(home.sessions)[0] ?? null;
  if (!target) return { session: null, reason: "no-api" };
  const session = home.sessions[target];
  return session ? { session } : { session: null, reason: "not-signed-in" };
}
