/**
 * `blaster send`, as an operator and a script would use it.
 *
 * A send is the one command that spends money and reaches a real person, so most
 * of what is pinned here is what the command refuses to do: no session, no send;
 * a missing recipient, no send; and never a profile chosen by the caller. The
 * profile is a property of the sending number's registration and lives on its
 * `agencyPhones` record, which only the API reads.
 *
 * The API is stubbed at the fetch boundary rather than by reaching past the CLI
 * into Telnyx, so the command, the session lookup and the request body are all
 * real and only the network is not.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { saveSessionRecord } from "@blaster/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEND_USAGE, formatSend, parseSendArgs, sendMain } from "../src/cli/send.ts";
import type { CliFlags } from "../src/cli/inbox.ts";

const API_URL = "https://blaster.example";

const flags = (entries: Record<string, string> = {}): CliFlags =>
  new Map(Object.entries(entries)) as CliFlags;

/** A throwaway project root with no session in it. */
function emptyHome(): string {
  return mkdtempSync(join(tmpdir(), "blaster-send-none-"));
}

/** A project root with one signed-in operator, which is what a send requires. */
function signedInHome(): string {
  const root = mkdtempSync(join(tmpdir(), "blaster-send-"));
  saveSessionRecord(
    root,
    {
      accessToken: "at-operator",
      refreshToken: null,
      expiresIn: 3600,
      obtainedAtMs: 1_000_000,
      username: "operator",
      apiUrl: API_URL,
      loggedInAt: "2026-09-29T00:00:00.000Z",
    },
    { apiUrl: API_URL },
  );
  return root;
}

interface Recorded {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: unknown;
}

/** Answer the API with a real-shaped send response and record what was asked. */
function stubApi(response: { status?: number; body?: unknown } = {}): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify(
          response.body ?? {
            sent: {
              id: "msg-1",
              status: "queued",
              from: "+15557654321",
              to: "+15551234567",
              profileId: "profile-1",
            },
            resolution: { profileId: "profile-1", reason: "bound-to-number", country: "US" },
          },
        ),
        { status: response.status ?? 200, headers: { "Content-Type": "application/json" } },
      );
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

describe("parseSendArgs", () => {
  test("reads recipient and body from two positionals", () => {
    expect(parseSendArgs(["+15551234567", "hello there"], new Map())).toEqual({
      to: "+15551234567",
      text: "hello there",
    });
  });

  test("reads recipient, sender and body from three positionals", () => {
    expect(parseSendArgs(["+15551234567", "+15557654321", "hi"], new Map())).toEqual({
      to: "+15551234567",
      from: "+15557654321",
      text: "hi",
    });
  });

  test("keeps a multi-word body as one message", () => {
    expect(parseSendArgs(["+15551234567", "two words here"], new Map()).text).toBe("two words here");
  });

  test("a body that starts with a plus is still a body", () => {
    // With two arguments the second is the message. Reading it as a sending
    // number would drop the message and send from the wrong place, which is why
    // the sender is only claimed when something is left over to be the body.
    expect(parseSendArgs(["+15551234567", "+44 20 7946 0958 is the office"], new Map())).toEqual({
      to: "+15551234567",
      text: "+44 20 7946 0958 is the office",
    });
  });

  test("flags win over positionals", () => {
    expect(
      parseSendArgs(["+15550000000"], flags({ to: "+15551234567", from: "+15557654321", text: "hi" })),
    ).toEqual({ to: "+15551234567", from: "+15557654321", text: "hi" });
  });

  test("a caller cannot smuggle a profile in through the flags", () => {
    // The profile is read from the sending number's Twenty record by the API.
    // If it could be passed in, a surface could send from a number against the
    // wrong registration, so the flag is dropped rather than forwarded.
    const parsed = parseSendArgs(["+15551234567", "hi"], flags({ numberProfileId: "profile-evil" }));
    expect(parsed).not.toHaveProperty("numberProfileId");
    expect(parsed.to).toBe("+15551234567");
    expect(parsed.text).toBe("hi");
    expect(parsed.from).toBeUndefined();
  });

  test("an omitted sender stays omitted, for the API to resolve", () => {
    const parsed = parseSendArgs(["+15551234567", "hi"], new Map());
    expect(parsed.from).toBeUndefined();
  });
});

describe("formatSend", () => {
  test("shows both numbers, the provider's status, and where the profile came from", () => {
    const line = formatSend(
      { id: "msg-1", status: "queued", from: "+15557654321", to: "+15551234567", profileId: "profile-1" },
      { profileId: "profile-1", reason: "bound-to-number", country: "US" },
    );
    expect(line).toContain("Sent msg-1");
    expect(line).toContain("+15557654321");
    expect(line).toContain("+15551234567");
    // Acceptance is not delivery, and the output must not imply otherwise:
    // delivery arrives later on the webhook.
    expect(line).toContain("status   queued");
    expect(line).toContain("bound-to-number");
  });

  test("surfaces a fallback warning rather than dropping it", () => {
    const line = formatSend(
      { id: "m", status: "queued", from: "+1", to: "+2", profileId: "p" },
      { profileId: "p", reason: "country-rule", country: "IE", warning: "no IE profile" },
    );
    expect(line).toContain("no IE profile");
  });
});

describe("blaster send", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test("the documented shape is the positional one", () => {
    expect(SEND_USAGE).toContain("blaster send <to> [from] <text>");
    expect(SEND_USAGE).toContain("blaster login");
  });

  test("refuses without a session and never reaches the network", async () => {
    const root = emptyHome();
    roots.push(root);
    const calls = stubApi();
    const { err } = captureOutput();

    const code = await sendMain(["+15551234567", "hello"], flags(), true, root);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/blaster login/);
    // Nothing may be sent to a server the operator never signed in to.
    expect(calls).toHaveLength(0);
  });

  test("a missing message is an error, not a prompt, when not interactive", async () => {
    const root = signedInHome();
    roots.push(root);
    const calls = stubApi();
    const { err } = captureOutput();

    const code = await sendMain(["+15551234567"], flags(), true, root);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/recipient and a message are required/);
    expect(calls).toHaveLength(0);
  });

  test("sends through the signed-in API with the operator's token", async () => {
    const root = signedInHome();
    roots.push(root);
    const calls = stubApi();
    const { out } = captureOutput();

    const code = await sendMain(["+15551234567", "Thanks, that works."], flags(), false, root);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API_URL}/api/messages/send`);
    expect(calls[0]?.method).toBe("POST");
    // The operator's own token, from `blaster login`. The CLI holds no Telnyx
    // key of its own, so this bearer is the whole of its credential.
    expect(calls[0]?.authorization).toBe("Bearer at-operator");
    expect(calls[0]?.body).toEqual({ to: "+15551234567", text: "Thanks, that works." });
    expect(out.join("\n")).toContain("Sent msg-1");
    expect(out.join("\n")).toContain("bound-to-number");
  });

  test("names the sending number when given one", async () => {
    const root = signedInHome();
    roots.push(root);
    const calls = stubApi();

    const code = await sendMain(
      ["+15551234567", "+15557654321", "hi"],
      flags(),
      true,
      root,
    );

    expect(code).toBe(0);
    expect(calls[0]?.body).toEqual({ to: "+15551234567", from: "+15557654321", text: "hi" });
  });

  test("a number with no profile in Twenty is a setup problem, not a crash", async () => {
    const root = signedInHome();
    roots.push(root);
    stubApi({
      status: 409,
      body: { error: "+15557654321 has no messaging profile in Twenty" },
    });
    const { err } = captureOutput();

    const code = await sendMain(["+15551234567", "hi"], flags(), false, root);

    // Exits 1, not 2: a missing profile is something the operator fixes in
    // Twenty, and 2 is reserved for a server that could not be reached at all.
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/no messaging profile/);
  });

  test("an expired session says to sign in again", async () => {
    const root = signedInHome();
    roots.push(root);
    stubApi({ status: 401, body: { error: "A live operator token is required" } });
    const { err } = captureOutput();

    const code = await sendMain(["+15551234567", "hi"], flags(), false, root);

    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/blaster login/);
  });

  test("an unreachable API exits 2, so a script can retry it", async () => {
    const root = signedInHome();
    roots.push(root);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    captureOutput();

    const code = await sendMain(["+15551234567", "hi"], flags(), false, root);

    expect(code).toBe(2);
  });
});
