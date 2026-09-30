/**
 * Guided `blaster send`, as an operator and a script would use it.
 *
 * Bare `blaster send` at a terminal picks a sending number, filters
 * prospects from the Twenty schema, previews eligibility, confirms the exact
 * send, and batches with per-recipient outcomes. What is pinned here is the
 * shape of that flow: choices come from mocked API responses (never invented
 * menus), cancellation sends nothing, JSON/CI never prompts, and a stale
 * session triggers a login only when a human is watching.
 *
 * The API is stubbed at the fetch boundary; the prompts are scripted
 * answers. The session home is real, on a throwaway root.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { saveSessionRecord } from "@blaster/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendMain } from "../src/cli/send.ts";
import { askConfirm, askSelect, askText } from "../src/cli/prompt.ts";
import type { CliFlags } from "../src/cli/inbox.ts";

const API_URL = "https://blaster.example";

const answers = vi.hoisted(() => ({
  select: [] as Array<string | null>,
  text: [] as Array<string | null>,
  confirm: [] as Array<boolean | null>,
}));

vi.mock("../src/cli/prompt.ts", () => ({
  isInteractive: (json: boolean) => !json,
  begin: vi.fn(),
  finish: vi.fn(),
  abort: vi.fn(() => 1),
  note: vi.fn(),
  cancelled: vi.fn(),
  askSelect: vi.fn(async () => answers.select.shift() ?? null),
  askText: vi.fn(async () => answers.text.shift() ?? null),
  askConfirm: vi.fn(async () => answers.confirm.shift() ?? null),
}));

const loginCalls: unknown[][] = [];

vi.mock("../src/cli/login.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/login.ts")>();
  return {
    ...actual,
    loginMain: async (...args: unknown[]) => {
      loginCalls.push(args);
      return 0;
    },
  };
});

const flags = (entries: Record<string, string | boolean> = {}): CliFlags =>
  new Map(Object.entries(entries)) as CliFlags;

/** A signed-in home. Fresh tokens validate; ancient ones are expired. */
function signedInHome(obtainedAtMs: number): string {
  const root = mkdtempSync(join(tmpdir(), "blaster-send-guided-"));
  saveSessionRecord(
    root,
    {
      accessToken: "at-operator",
      refreshToken: null,
      expiresIn: 3600,
      obtainedAtMs,
      username: "operator",
      apiUrl: API_URL,
      loggedInAt: "2026-09-29T00:00:00.000Z",
    },
    { apiUrl: API_URL },
  );
  return root;
}

interface Recorded {
  path: string;
  body: unknown;
}

const PROSPECT = { id: "p-1", name: "Acme", phone: "+15550001111", country: "US", campaign: null };

/** Answer every API route with canned payloads and record the calls. */
function stubApi(overrides: Record<string, (body: unknown) => unknown> = {}): Recorded[] {
  const calls: Recorded[] = [];
  const routes: Record<string, (body: unknown) => unknown> = {
    "/api/auth/me": () => ({ username: "operator", scope: "api" }),
    "/api/agency-phones": () => ({
      count: 2,
      phones: [
        { agencyPhoneId: "rec-1", phoneNumber: "+15557654321", label: "+15557654321 (US)", countryCode: "US" },
        { agencyPhoneId: "rec-2", phoneNumber: "+15559876543", label: "+15559876543", countryCode: null },
      ],
    }),
    "/api/prospects/fields": () => ({
      fields: [{ name: "niche", label: "Industry", type: "string", filterOperators: ["eq", "neq"] }],
    }),
    "/api/prospects/search": () => ({ total: 1, prospects: [PROSPECT], nextCursor: null }),
    "/api/messages/preview": () => ({ total: 1, eligible: 1, skipped: 0, sample: [PROSPECT] }),
    "/api/messages/batch-send": (body) => {
      const input = body as { agencyPhoneId: string; text: string; idempotencyKey: string };
      return {
        agencyPhoneId: input.agencyPhoneId,
        from: "+15559876543",
        idempotencyKey: input.idempotencyKey,
        total: 1,
        sent: 1,
        skipped: 0,
        failed: 0,
        outcomes: [{ prospectId: "p-1", phone: "+15550001111", status: "sent", telnyxId: "telnyx-1" }],
      };
    },
    ...overrides,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
      calls.push({ path: url.pathname, body });
      const handler = routes[url.pathname];
      if (!handler) return new Response(JSON.stringify({ error: "not mocked" }), { status: 500 });
      return new Response(JSON.stringify(handler(body)), { status: 200 });
    }),
  );
  return calls;
}

function captureOutput(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  });
  return { out, err };
}

describe("guided blaster send", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    answers.select.length = 0;
    answers.text.length = 0;
    answers.confirm.length = 0;
    loginCalls.length = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("number, done filters, text, confirm, batch with the id the server resolves", async () => {
    const root = signedInHome(Date.now());
    roots.push(root);
    const calls = stubApi();
    answers.select.push("rec-2", "__done");
    answers.text.push("hello there");
    answers.confirm.push(true);
    const { out } = captureOutput();

    const code = await sendMain([], flags(), false, root);

    expect(code).toBe(0);
    const batch = calls.find((call) => call.path === "/api/messages/batch-send");
    expect(batch?.body).toMatchObject({ agencyPhoneId: "rec-2", filters: [], text: "hello there" });
    expect(typeof (batch?.body as { idempotencyKey?: unknown })?.idempotencyKey).toBe("string");
    expect(out.join("\n")).toContain("Batch complete: 1 sent");
  });

  test("cancelling the number pick sends nothing", async () => {
    const root = signedInHome(Date.now());
    roots.push(root);
    const calls = stubApi();
    answers.select.push(null);
    captureOutput();

    const code = await sendMain([], flags(), false, root);

    expect(code).toBe(1);
    expect(calls.some((call) => call.path === "/api/messages/batch-send")).toBe(false);
    expect(calls.some((call) => call.path === "/api/prospects/search")).toBe(false);
  });

  test("a stale session triggers a login only when interactive", async () => {
    const root = signedInHome(1);
    roots.push(root);
    const calls = stubApi();
    captureOutput();

    const code = await sendMain([], flags(), false, root);

    expect(loginCalls).toHaveLength(1);
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("scripted batch flags never prompt and print machine output with --json", async () => {
    const root = signedInHome(Date.now());
    roots.push(root);
    const calls = stubApi();
    const { out } = captureOutput();

    const code = await sendMain(
      [],
      flags({
        "agency-phone-id": "rec-1",
        filter: JSON.stringify([{ field: "niche", operator: "eq", value: "plumbing" }]),
        text: "hi",
        yes: true,
      }),
      true,
      root,
    );

    expect(code).toBe(0);
    expect(vi.mocked(askSelect)).not.toHaveBeenCalled();
    expect(vi.mocked(askText)).not.toHaveBeenCalled();
    expect(vi.mocked(askConfirm)).not.toHaveBeenCalled();
    const batch = calls.find((call) => call.path === "/api/messages/batch-send");
    expect(batch?.body).toMatchObject({
      agencyPhoneId: "rec-1",
      filters: [{ field: "niche", operator: "eq", value: "plumbing" }],
      text: "hi",
    });
    expect(() => JSON.parse(out.join("\n"))).not.toThrow();
  });

  test("scripted batch without --yes is a usage error, not a prompt", async () => {
    const root = signedInHome(Date.now());
    roots.push(root);
    const calls = stubApi();
    const { err } = captureOutput();

    const code = await sendMain(
      [],
      flags({ "agency-phone-id": "rec-1", filter: "[]", text: "hi" }),
      true,
      root,
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/--yes/);
    expect(calls).toHaveLength(0);
  });
});
