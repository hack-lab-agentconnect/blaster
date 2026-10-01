import { describe, expect, test, vi } from "vitest";
import { sendBarkPush } from "../src/bark/index.ts";
import { getBarkServerUrl } from "../src/bark/helpers/get-server-url.ts";
import { redactKey } from "../src/bark/helpers/redact-key.ts";
import { extractBarkKey } from "../src/twenty/workspaceMember/index.ts";
import { broadcastReply, formatReplyBody } from "../src/conversation/notify/index.ts";
import type { TwentyClient } from "../src/twenty/client/index.ts";

/**
 * The reply notification, and the push channel under it.
 *
 * The properties worth pinning are all about *not* breaking things: a device key
 * is a credential and must never appear whole, a push failure must not throw, and
 * a member with no key must be skipped rather than counted as a failure.
 */

const ENV = { OPENAI_API_KEY: "" } as NodeJS.ProcessEnv;
const env = { BARK_SERVER_URL: "https://bark.test" } as NodeJS.ProcessEnv;

const ok = (body: unknown = { code: 200, message: "success" }) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("the server and the key", () => {
  test("the public server is the default, and a trailing slash cannot double up", () => {
    expect(getBarkServerUrl({} as NodeJS.ProcessEnv)).toBe("https://api.day.app");
    expect(getBarkServerUrl({ BARK_SERVER_URL: "https://self.hosted/bark/" } as NodeJS.ProcessEnv)).toBe(
      "https://self.hosted/bark",
    );
  });

  test("a key is redacted to enough to tell two apart", () => {
    expect(redactKey("abcdefgh12345678")).toBe("abcd...5678");
    // A short key is masked entirely rather than half-revealed.
    expect(redactKey("short")).toBe("***");
  });
});

describe("extractBarkKey", () => {
  test("a rich-text field yields its markdown", () => {
    expect(extractBarkKey({ blocknote: {}, markdown: "devicekey123" })).toBe("devicekey123");
  });

  test("a bare string works, and is trimmed", () => {
    // Rich-text editing leaves trailing newlines that break every push.
    expect(extractBarkKey("  devicekey123\n")).toBe("devicekey123");
  });

  test("an unconfigured member is null, not a failure", () => {
    expect(extractBarkKey(null)).toBeNull();
    expect(extractBarkKey(undefined)).toBeNull();
    expect(extractBarkKey({ markdown: "   " })).toBeNull();
    expect(extractBarkKey(42)).toBeNull();
  });
});

describe("sendBarkPush", () => {
  test("a delivered push reports success", async () => {
    const fetchFn = vi.fn(async () => ok()) as unknown as typeof fetch;
    const result = await sendBarkPush("key123456", { body: "hello" }, env, fetchFn);
    expect(result).toMatchObject({ ok: true, status: 200 });
  });

  test("it posts to /push with the device key and body", async () => {
    let url = "";
    let body: Record<string, unknown> = {};
    const fetchFn = (async (target: string, init?: RequestInit) => {
      url = String(target);
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok();
    }) as unknown as typeof fetch;

    await sendBarkPush("key123456", { title: "Prospect replied", body: "hi" }, env, fetchFn);
    expect(url).toBe("https://bark.test/push");
    expect(body.device_key).toBe("key123456");
    expect(body.title).toBe("Prospect replied");
  });

  test("a 200 carrying a failing code is a failure", async () => {
    // Bark can answer 200 with a non-200 code, so response.ok alone lies.
    const fetchFn = (async () =>
      ok({ code: 400, message: "bad device key" })) as unknown as typeof fetch;
    expect(await sendBarkPush("key123456", { body: "hi" }, env, fetchFn)).toMatchObject({ ok: false });
  });

  test("an unreachable server is a result, not an exception", async () => {
    // A notification must never be able to fail the event that caused it.
    const fetchFn = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await sendBarkPush("key123456", { body: "hi" }, env, fetchFn);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/unreachable/i);
  });

  test("the device key never appears whole in a failure message", async () => {
    const fetchFn = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await sendBarkPush("supersecretkey1234", { body: "hi" }, env, fetchFn);
    expect(result.message).not.toContain("supersecretkey1234");
    expect(result.message).toContain(redactKey("supersecretkey1234"));
  });

  test("a missing key or body is refused without a request", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect((await sendBarkPush("", { body: "hi" }, env, fetchFn)).ok).toBe(false);
    expect((await sendBarkPush("key123456", { body: "  " }, env, fetchFn)).ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("broadcastReply", () => {
  const member = (id: string, barkKey: string | null) => ({
    id,
    userId: `u-${id}`,
    userEmail: `${id}@test`,
    firstName: id,
    lastName: "Member",
    name: { firstName: id, lastName: "Member" },
    barkKeyRaw: barkKey,
    barkKey,
  });

  const clientWith = (rows: unknown[]) =>
    ({ listAll: async () => rows }) as unknown as TwentyClient;

  const notification = { peer: "+15551234567", preview: "how much is this", stoppedCount: 2 };

  test("only members with a key are pushed to", async () => {
    const fetchFn = vi.fn(async () => ok()) as unknown as typeof fetch;
    const result = await broadcastReply(
      clientWith([member("a", "key-a"), member("b", null), member("c", "key-c")]),
      notification,
      env,
      fetchFn,
    );
    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(2);
    // No key is a configuration state, not a failure.
    expect(result.skippedNoKey).toBe(1);
    expect(result.failed).toBe(0);
  });

  test("one bad key does not fail the others", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { device_key: string };
      return body.device_key === "key-bad"
        ? new Response("nope", { status: 500 })
        : ok();
    }) as unknown as typeof fetch;
    const result = await broadcastReply(
      clientWith([member("a", "key-good"), member("b", "key-bad")]),
      notification,
      env,
      fetchFn,
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  test("nobody with a key is a quiet no-op", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await broadcastReply(clientWith([member("a", null)]), notification, env, fetchFn);
    expect(result).toMatchObject({ attempted: 0, sent: 0, skippedNoKey: 1, aborted: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("Twenty being unreachable aborts rather than throwing", async () => {
    const client = {
      listAll: async () => {
        throw new Error("503");
      },
    } as unknown as TwentyClient;
    const result = await broadcastReply(client, notification, env, vi.fn() as unknown as typeof fetch);
    // A Twenty outage must not become a webhook 500, which Telnyx would retry.
    expect(result.aborted).toBe(true);
  });

  test("the push is time-sensitive and grouped, because a reply is waited on", async () => {
    let payload: Record<string, unknown> = {};
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok();
    }) as unknown as typeof fetch;
    await broadcastReply(clientWith([member("a", "key-a")]), notification, env, fetchFn);
    expect(payload.level).toBe("timeSensitive");
    expect(payload.group).toBe("replies");
  });
});

describe("the push text", () => {
  test("it says what stopped, and says so when nothing did", () => {
    expect(formatReplyBody({ peer: "+1", preview: "hi", stoppedCount: 2 })).toContain(
      "Stopped 2 sequence step(s).",
    );
    expect(formatReplyBody({ peer: "+1", preview: "hi", stoppedCount: 0 })).toContain(
      "No active sequence.",
    );
    expect(formatReplyBody({ peer: "+1", preview: "hi", stoppedCount: 1 })).toContain("+1: hi");
  });
});

void ENV;
