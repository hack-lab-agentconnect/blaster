import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createBlasterApiClient, type ConversationSummary } from "@blaster/core";
import { loadSessionHome, saveSessionRecord } from "@blaster/core";
import { inboxList, inboxShow } from "../src/cli/inbox.ts";

/**
 * The parity claim, made checkable.
 *
 * The CLI and MCP both read the inbox through `createBlasterApiClient`, so the
 * only way they can return different data is if one of them formats or filters
 * differently. This pins that: the same session, the same request, the same
 * rows out, and the same query parameters sent.
 *
 * The session is real and written to a temporary root, so the test also proves
 * the store the MCP server reads is the store `blaster login` writes.
 */

const CONVERSATIONS: ConversationSummary[] = [
  {
    id: "k171855q923bdkx00je595qmmn8fa832",
    phoneNumber: "+13125550001",
    blasterNumber: "+14705550199",
    latestMessageAt: 1_700_000_000_000,
    latestDirection: "inbound",
    latestPreview: "is this the right number",
    messageCount: 3,
    latestMessageId: "m-3",
  },
];

const MESSAGES = [
  {
    id: "m-1",
    direction: "inbound" as const,
    body: "is this the right number",
    from: "+13125550001",
    to: "+14705550199",
    status: "received",
    telnyxMessageId: "t-1",
    sentAt: 1_700_000_000_000,
    media: null,
  },
];

let root = "";
const requests: Array<{ url: string; auth: string | null }> = [];
let output: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blaster-inbox-"));
  mkdirSync(join(root, ".blaster"), { recursive: true });
  // Exactly what `blaster login` writes.
  writeFileSync(
    join(root, ".blaster", "config.json"),
    `${JSON.stringify({ apiUrl: "http://127.0.0.1:4180" }, null, 2)}\n`,
  );
  saveSessionRecord(root, {
    accessToken: "op-token",
    refreshToken: "refresh-token",
    expiresIn: 3600,
    obtainedAtMs: Date.now(),
    username: "operator@example.com",
    apiUrl: "http://127.0.0.1:4180",
    loggedInAt: new Date().toISOString(),
  });

  requests.length = 0;
  output = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    output.push(String(line));
  });

  // The API the CLI and MCP both call.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), auth: new Headers(init?.headers).get("Authorization") });
      const path = String(url);
      // The CLI authenticates before it reads anything, so the session check is
      // part of the route surface rather than a detail of one command.
      if (path.includes("/auth/me")) return new Response(JSON.stringify({ username: "operator@example.com", scope: "api" }));
      if (path.includes("/messages")) return new Response(JSON.stringify({ messages: MESSAGES }));
      return new Response(JSON.stringify({ conversations: CONVERSATIONS }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const flags = (pairs: Array<[string, string]>): Map<string, string | boolean> =>
  new Map(pairs) as Map<string, string | boolean>;

describe("the operator session store", () => {
  test("what login writes is what every surface reads", () => {
    const home = loadSessionHome(root);
    const session = home.sessions["http://127.0.0.1:4180"];
    expect(session?.accessToken).toBe("op-token");
    expect(home.config.apiUrl).toBe("http://127.0.0.1:4180");
  });
});

describe("blaster inbox list", () => {
  test("sends the operator token and the filters the caller asked for", async () => {
    const code = await inboxList(flags([["number", "+1 470 555 0199"], ["limit", "5"]]), false, root);
    expect(code).toBe(0);
    // The session is authenticated before anything is read, so that call comes
    // first. It is part of the route surface, not a detail of one command.
    expect(new URL(requests[0]!.url).pathname).toBe("/api/auth/me");
    expect(requests[0]?.auth).toBe("Bearer op-token");
    const read = requests.find((row) => row.url.includes("/api/conversations"))!;
    expect(read.auth).toBe("Bearer op-token");
    const url = new URL(read.url);
    expect(url.pathname).toBe("/api/conversations");
    expect(url.searchParams.get("number")).toBe("+1 470 555 0199");
    expect(url.searchParams.get("limit")).toBe("5");
    // No campaign asked for, so it is not resolved.
    expect(url.searchParams.has("campaign")).toBe(false);
  });

  test("--json returns the same rows the API returned", async () => {
    await inboxList(flags([]), true, root);
    const payload = JSON.parse(output.join("\n")) as { count: number; conversations: ConversationSummary[] };
    expect(payload.count).toBe(1);
    expect(payload.conversations).toEqual(CONVERSATIONS);
  });

  test("the human view names the peer, the number, and the preview", async () => {
    await inboxList(flags([]), false, root);
    const text = output.join("\n");
    expect(text).toContain("+13125550001");
    expect(text).toContain("is this the right number");
  });

  test("a missing session is a message naming the fix, not a crash", async () => {
    rmSync(join(root, ".blaster", "sessions.json"), { force: true });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)));
    const code = await inboxList(flags([]), false, root);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("blaster login");
  });
});

describe("blaster inbox show", () => {
  test("reads one thread and needs no positional guess", async () => {
    const code = await inboxShow(["k171855q923bdkx00je595qmmn8fa832"], flags([]), false, root);
    expect(code).toBe(0);
    // Skipped past the session check, which now precedes every read.
    expect(requests.some((row) => row.url.includes("/api/conversations/k171855q923bdkx00je595qmmn8fa832/messages"))).toBe(true);
    expect(output.join("\n")).toContain("prospect");
  });

  test("a missing id is refused before any request", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => errors.push(String(line)));
    const code = await inboxShow([], flags([]), false, root);
    expect(code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(errors.join("\n")).toContain("conversation id");
  });
});

describe("parity", () => {
  test("the shared client and the CLI produce identical rows for one query", async () => {
    await inboxList(flags([]), true, root);
    const fromCli = JSON.parse(output.join("\n")) as { conversations: ConversationSummary[] };

    // Exactly what MCP does: build the client from the same session.
    const home = loadSessionHome(root);
    const apiUrl = home.config.apiUrl as string;
    const session = home.sessions[apiUrl]!;
    const rows = await createBlasterApiClient({
      baseUrl: apiUrl,
      accessToken: session.accessToken,
    }).listConversations();

    expect(fromCli.conversations).toEqual(rows);
    expect(rows).toEqual(CONVERSATIONS);
  });

  test("the thread rows are identical too", async () => {
    await inboxShow(["k171855q923bdkx00je595qmmn8fa832"], flags([]), true, root);
    const fromCli = JSON.parse(output.join("\n")) as { messages: unknown[] };
    const home = loadSessionHome(root);
    const apiUrl = home.config.apiUrl as string;
    const rows = await createBlasterApiClient({
      baseUrl: apiUrl,
      accessToken: home.sessions[apiUrl]!.accessToken,
    }).conversationMessages("k171855q923bdkx00je595qmmn8fa832");
    expect(fromCli.messages).toEqual(rows);
  });
});
