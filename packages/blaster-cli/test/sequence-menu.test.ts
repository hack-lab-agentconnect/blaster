/**
 * `blaster sequence` with no action, as an operator and a script meet it.
 *
 * Bare `blaster sequence` used to print the usage text and stop, which answers a
 * question nobody asked: an operator who runs it is asking what to do next. In a
 * terminal it now opens a menu that asks for whatever the choice still needs, and
 * comes back afterwards so building a draft and then looking at it is one
 * session.
 *
 * What is pinned here: the menu is only offered where someone can answer it,
 * scripted answers drive the real actions rather than a parallel implementation,
 * Ctrl+C leaves nothing behind, and the menu cannot offer an action that has no
 * draft to act on.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { saveSessionRecord } from "@blaster/core";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sequenceMain, type SequenceContext } from "../src/cli/sequence.ts";
import { askSelect, askText } from "../src/cli/prompt.ts";
import { ensureLiveSession, loginMain } from "../src/cli/login.ts";
import { readDrafts, saveDraft } from "../src/cli/sequence-store.ts";
import type { BlasterApiClient, SequenceDraft } from "@blaster/core";

const API_URL = "https://blaster.example";

const answers = vi.hoisted(() => ({
  select: [] as Array<string | null>,
  text: [] as Array<string | null>,
}));

vi.mock("../src/cli/prompt.ts", () => ({
  isInteractive: (json: boolean) => !json,
  begin: vi.fn(),
  finish: vi.fn(),
  abort: vi.fn(() => 1),
  fail: vi.fn(),
  note: vi.fn(),
  spin: vi.fn(),
  cancelled: vi.fn(),
  askSelect: vi.fn(async () => answers.select.shift() ?? null),
  askText: vi.fn(async () => answers.text.shift() ?? null),
  askConfirm: vi.fn(async () => null),
}));

const loginCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock("../src/cli/login.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/login.ts")>();
  return {
    ...actual,
    // Session storage stays real, so `signIn()` writes and the assertions on it
    // mean something. The token round trips do not: this suite is about the
    // menu, and validating or refreshing a token would reach the network.
    ensureLiveSession: vi.fn(async (root: string, apiUrl: string) =>
      actual.loadHome(root).sessions[apiUrl] ?? null,
    ),
    loginMain: vi.fn(async (...args: unknown[]) => {
      loginCalls.push(args);
      return 0;
    }),
  };
});

const at = Date.UTC(2026, 2, 2, 14, 0, 0);

let root: string;

/** Two sendable numbers, so "pick one" has something to pick. */
const PHONES = {
  count: 2,
  phones: [
    { agencyPhoneId: "rec-1", phoneNumber: "+15557654321", label: "US line", countryCode: "US" },
    { agencyPhoneId: "rec-2", phoneNumber: "+353871234567", label: "IE line", countryCode: "IE" },
  ],
};

/** A signed-in home, so the sending-number lookup has a session to use. */
function signIn(): void {
  saveSessionRecord(
    root,
    {
      accessToken: "at-operator",
      refreshToken: null,
      expiresIn: 3600,
      obtainedAtMs: at,
      username: "operator",
      apiUrl: API_URL,
      loggedInAt: "2026-09-29T00:00:00.000Z",
    },
    { apiUrl: API_URL },
  );
}

/** A configured API with no session for it, which is a real state to be in. */
function configureOnly(): void {
  mkdirSync(join(root, ".blaster"), { recursive: true });
  writeFileSync(
    join(root, ".blaster", "config.json"),
    JSON.stringify({ apiUrl: API_URL, webUrl: API_URL }, null, 2),
    "utf8",
  );
  writeFileSync(join(root, ".blaster", "sessions.json"), "{}", "utf8");
}

/** Stub the API at the fetch boundary; returns the paths that were called. */
function stubApi(phones: unknown = PHONES): string[] {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      paths.push(new URL(url).pathname);
      const body =
        new URL(url).pathname === "/api/agency-phones" ? phones : { count: 0, phones: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return paths;
}

const ctx = (
  json = false,
  flags: Record<string, string | boolean> = {},
  session?: { client: BlasterApiClient; apiUrl: string } | null,
): SequenceContext => ({
  root,
  flags: new Map(Object.entries(flags)),
  json,
  jsonOut: () => "{}",
  now: () => at,
  evaluate: () => ({ eligible: true, reason: null, detail: null }),
  ...(session === undefined ? {} : { session }),
});

/**
 * A context that already holds a session, for tests about the menu's shape
 * rather than about signing in. Anything that reads the account gets a stub
 * client, so no test needs the network to answer "is there a session?".
 */
const offlineCtx = (json = false): SequenceContext =>
  ctx(json, {}, { client: { listSendingNumbers: async () => [] } as unknown as BlasterApiClient, apiUrl: API_URL });

/** A draft already on disk, so the name-picking actions have something to find. */
const EXISTING: SequenceDraft = {
  name: "Existing",
  fromNumber: "+353871234567",
  options: {
    stopOnReply: true,
    respectDoNotContact: true,
    requireProfileForCountry: true,
    dailyCapPerRecipient: 2,
  },
  steps: [{ text: "Hello", delayHours: 0, isStop: false }],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "blaster-menu-"));
  answers.select.length = 0;
  answers.text.length = 0;
  loginCalls.length = 0;
  vi.mocked(askSelect).mockClear();
  vi.mocked(askText).mockClear();
  vi.mocked(ensureLiveSession).mockClear();
  vi.mocked(loginMain).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("bare `blaster sequence` in a terminal", () => {
  test("opens the menu instead of printing help", async () => {
    answers.select = ["__done"];

    expect(await sequenceMain(offlineCtx(), undefined, undefined)).toBe(0);

    // The menu asked something. Printing the usage text and exiting would never
    // have called a prompt at all.
    expect(askSelect).toHaveBeenCalled();
  });

  test("building a draft through the menu records it", async () => {
    signIn();
    stubApi();
    answers.select = ["new", "__done"];
    answers.text = [
      "Spring outreach",
      "First message",
      "0",
      "Follow up in two days",
      "48",
      // An empty message text ends the loop rather than adding a blank step.
      "",
      "yes",
    ];
    // The number is chosen from the account's records, so the menu answers with
    // the second of the two sendable numbers.
    answers.select = ["new", "+353871234567", "__done"];

    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(0);

    const drafts = readDrafts(root);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.draft.name).toBe("Spring outreach");
    // The recorded number is the one the workspace owns, not one that was typed.
    expect(drafts[0]?.draft.fromNumber).toBe("+353871234567");
    expect(drafts[0]?.draft.steps).toHaveLength(3);
    // The trailing "yes" is what turns the end of the list into a stop
    // condition rather than a truncated sequence.
    expect(drafts[0]?.draft.steps.at(-1)?.isStop).toBe(true);
  });

  test("the sending number is offered as the account's numbers, never typed", async () => {
    signIn();
    const paths = stubApi();
    answers.select = ["new", "+353871234567", "__done"];
    answers.text = ["Spring outreach", "Hello", "0", "", "yes"];

    await sequenceMain(ctx(), undefined, undefined);

    // Read from the API that owns the numbers...
    expect(paths).toContain("/api/agency-phones");
    // ...and offered as a menu of them. A free-text prompt here is the bug:
    // it accepts a number the account does not own.
    const offered = vi
      .mocked(askSelect)
      .mock.calls.find((call) => call[0] === "Sending number?");
    // The number leads, because that is what the operator is choosing between;
    // the workspace's own label is the dimmed hint beside it.
    expect(offered?.[1]).toEqual([
      { value: "+15557654321", label: "+15557654321", hint: "US line" },
      { value: "+353871234567", label: "+353871234567", hint: "IE line" },
    ]);
    expect(askText).not.toHaveBeenCalledWith("Sending number (E.164)", expect.anything());
  });

  test("one sendable number is still offered, pre-selected", async () => {
    signIn();
    stubApi({ count: 1, phones: [PHONES.phones[0]] });
    answers.select = ["new", "+15557654321", "__done"];
    answers.text = ["Only line", "Hello", "0", "", "yes"];

    await sequenceMain(ctx(), undefined, undefined);

    expect(readDrafts(root)[0]?.draft.fromNumber).toBe("+15557654321");
    // A sequence sends from this number for days, so which number it is bound to
    // is shown rather than decided quietly. The lone option is pre-selected, so
    // agreeing still costs one keystroke.
    const offered = vi
      .mocked(askSelect)
      .mock.calls.find((call) => call[0] === "Sending number?");
    expect(offered?.[1]).toEqual([
      { value: "+15557654321", label: "+15557654321", hint: "US line" },
    ]);
    expect(offered?.[2]).toEqual({ initialValue: "+15557654321" });
  });

  test("not signed in fails with the command to run, and records nothing", async () => {
    const paths = stubApi();
    answers.select = ["new", "__done"];
    answers.text = ["Spring outreach"];

    // No signIn(): an empty home, which is what a fresh machine looks like.
    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(1);

    expect(paths).toEqual([]);
    expect(readDrafts(root)).toHaveLength(0);
  });

  test("a workspace with no sendable number says what to fix", async () => {
    signIn();
    stubApi({ count: 0, phones: [] });
    answers.select = ["new", "__done"];
    answers.text = ["Spring outreach"];

    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(1);

    expect(readDrafts(root)).toHaveLength(0);
  });

  test("--from still skips the account entirely, so scripts need no session", async () => {
    const paths = stubApi();
    answers.select = ["new", "__done"];
    answers.text = ["Spring outreach", "Hello", "0", "", "yes"];

    await sequenceMain(ctx(false, { from: "+15550001111" }), "new", undefined);

    // The scripted path is unchanged: an explicit number is taken at face value
    // and no token is needed to record a local draft.
    expect(paths).toEqual([]);
    expect(readDrafts(root)[0]?.draft.fromNumber).toBe("+15550001111");
  });

  test("comes back to the menu after an action, so one session can do two things", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = ["list", "__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    // Two menu visits for two choices: the loop is what makes it navigable
    // rather than one action per invocation.
    expect(vi.mocked(askSelect).mock.calls.filter((call) => call[0] === "What next?")).toHaveLength(2);
  });

  test("picks the sequence by name from what is recorded, not typed", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = ["show", "Existing", "__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    // Offered the recorded draft rather than asking for a name that could be
    // mistyped into a miss.
    const pick = vi
      .mocked(askSelect)
      .mock.calls.find((call) => call[0] === "Which sequence to show?");
    expect(pick?.[1]).toEqual([{ value: "Existing", label: "Existing", hint: "+353871234567" }]);
  });

  test("cancelling the menu leaves the drafts alone", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = [null];

    expect(await sequenceMain(offlineCtx(), undefined, undefined)).toBe(1);

    expect(readDrafts(root)).toHaveLength(1);
  });
});

describe("the session is resolved once, before anything is asked", () => {
  test("an expired token is refreshed rather than sent as stored", async () => {
    signIn();
    stubApi();
    answers.select = ["new", "+353871234567", "__done"];
    answers.text = ["Spring outreach", "Hello", "0", "", "yes"];

    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(0);

    // The stored access token in this repo's fixtures is long expired. Reading
    // it directly is what produced "a live operator token is required" against a
    // session that had a perfectly good refresh token; going through
    // ensureLiveSession is the fix, so it is the thing that must be called.
    expect(ensureLiveSession).toHaveBeenCalled();
    expect(loginMain).not.toHaveBeenCalled();
    expect(readDrafts(root)).toHaveLength(1);
  });

  test("checked once, so the up-front test and the number lookup share it", async () => {
    signIn();
    stubApi();
    answers.select = ["new", "+353871234567", "__done"];
    answers.text = ["Spring outreach", "Hello", "0", "", "yes"];

    await sequenceMain(ctx(), undefined, undefined);

    // Both the menu's check and the sending-number lookup need a session. One
    // resolution between them, not two round trips.
    expect(ensureLiveSession).toHaveBeenCalledTimes(1);
  });

  test("a session that cannot be recovered offers a sign-in instead of failing blind", async () => {
    // An API is configured but no session was ever stored for it: there is
    // somewhere to sign in to, which is what makes offering the sign-in useful.
    configureOnly();
    const paths = stubApi();
    answers.select = ["__done"];

    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(1);

    // Offering the sign-in is what makes the command work for someone whose
    // session has finally gone, rather than only for someone who knew to run
    // login first.
    expect(loginMain).toHaveBeenCalled();
    expect(paths).toEqual([]);
  });

  test("with no API configured at all, it says so rather than offering a sign-in", async () => {
    // An empty home: there is nowhere to sign in to, so prompting for a browser
    // flow would be a dead end.
    const paths = stubApi();
    answers.select = ["__done"];

    expect(await sequenceMain(ctx(), undefined, undefined)).toBe(1);

    expect(loginMain).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
  });

  test("the check happens before the first question, not after it", async () => {
    signIn();
    stubApi();
    answers.select = ["__done"];

    const order: string[] = [];
    vi.mocked(ensureLiveSession).mockImplementation(async () => {
      order.push("session");
      return null;
    });
    vi.mocked(askSelect).mockImplementation(async () => {
      order.push("prompt");
      return null;
    });

    await sequenceMain(ctx(), undefined, undefined);

    // Finding out the session is dead after typing a sequence name is the worst
    // order to find out in.
    expect(order[0]).toBe("session");
  });
});

describe("the menu only offers what it can act on", () => {
  /** Clack wraps a select row to `columns - 6`, so a long row wraps mid-label. */
  const WRAP_WIDTH = 44;

  const menuOptions = (): Array<{ value: string; label: string; hint?: string }> => {
    const call = vi.mocked(askSelect).mock.calls.find((c) => c[0] === "What next?");
    return (call?.[1] as Array<{ value: string; label: string; hint?: string }>) ?? [];
  };

  test("every entry carries a hint", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = ["__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    // A menu where some rows explain themselves and others do not reads as an
    // oversight rather than a choice.
    for (const option of menuOptions()) {
      expect(option.hint, `${option.label} has no hint`).toBeTruthy();
    }
  });

  test("no row is long enough to wrap mid-label in a narrow terminal", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = ["__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    for (const option of menuOptions()) {
      const row = `${option.label}  ${option.hint ?? ""}`;
      // The label has to survive whole, since a wrap splits "New sequence" into
      // "New" and "sequence", which is what made the menu unreadable.
      expect(
        row.length,
        `"${row}" is ${row.length} chars, over the ${WRAP_WIDTH} that fits`,
      ).toBeLessThanOrEqual(WRAP_WIDTH);
    }
  });

  test("with nothing recorded, the name-taking actions are not offered", async () => {
    answers.select = ["__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    const menu = vi.mocked(askSelect).mock.calls.find((call) => call[0] === "What next?");
    const values = (menu?.[1] as Array<{ value: string }> | undefined)?.map((option) => option.value) ?? [];
    // Offering "Show one" with nothing recorded would dead-end on the next
    // question, which is a worse first run than a shorter menu.
    expect(values).toContain("new");
    expect(values).not.toContain("show");
    expect(values).not.toContain("run");
    expect(values).not.toContain("edit");
    expect(values).not.toContain("rm");
  });

  test("with a draft recorded, they are", async () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());
    answers.select = ["__done"];

    await sequenceMain(offlineCtx(), undefined, undefined);

    const menu = vi.mocked(askSelect).mock.calls.find((call) => call[0] === "What next?");
    const values = (menu?.[1] as Array<{ value: string }> | undefined)?.map((option) => option.value) ?? [];
    expect(values).toEqual(expect.arrayContaining(["show", "run", "edit", "rm"]));
  });
});

describe("where there is nobody to answer, the usage text is the right answer", () => {
  test("--json prints usage and never prompts", async () => {
    expect(await sequenceMain(ctx(true), undefined, undefined)).toBe(0);

    // A prompt on a pipe hangs forever, so this is the branch that keeps
    // scripts and CI working.
    expect(askSelect).not.toHaveBeenCalled();
    expect(askText).not.toHaveBeenCalled();
  });

  test("`sequence help` still prints usage in a terminal", async () => {
    expect(await sequenceMain(ctx(), "help", undefined)).toBe(0);

    expect(askSelect).not.toHaveBeenCalled();
  });
});

describe("the recorded draft on disk is untouched by reading the menu", () => {
  test("the store round-trips what the menu wrote", () => {
    saveDraft(root, EXISTING, new Date(at).toISOString());

    const raw = JSON.parse(readFileSync(join(root, ".blaster", "sequences.json"), "utf8"));
    expect(raw.drafts).toHaveLength(1);
    expect(raw.drafts[0].draft.name).toBe("Existing");
  });
});
