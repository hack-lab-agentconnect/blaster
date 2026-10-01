/**
 * Bark: push notifications to a member's phone.
 *
 * The device key is a per-member `BARK_KEY` held on the Twenty
 * `workspaceMember` object, so a notification is addressed to the person rather
 * than to a shared channel, and a member with no key configured is simply not
 * notified. That is why the fan-out filters on the key rather than treating a
 * missing key as an error.
 *
 * A notification is never load-bearing. Nothing here throws for a delivery
 * problem, and a caller is expected to fire and forget: a push that fails must
 * not fail the event that caused it, because a reply that was stored and stopped
 * a sequence is worth far more than the push that said so.
 *
 * No logging in this module, deliberately. It is shared with Convex, where a
 * stray `console.log` in a mutation is noise at best, and a caller that wants to
 * record an outcome should do it with the returned result rather than have this
 * module decide. The device key is never included in a result or an error.
 */

import { getBarkServerUrl, redactKey } from "./helpers/index.ts";
import type { BarkBroadcastResult, BarkPushOptions, BarkPushResult } from "./types.ts";

export type { BarkBroadcastResult, BarkPushOptions, BarkPushResult };

/**
 * Send one push.
 *
 * Bark's API v2 is `POST {server}/push`. The response body carries a `code` field
 * that can disagree with the HTTP status, so both are checked: a 200 carrying
 * `code: 400` is a failure that an `response.ok` check alone would report as a
 * success.
 */
export async function sendBarkPush(
  deviceKey: string,
  options: BarkPushOptions,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): Promise<BarkPushResult> {
  const key = (deviceKey ?? "").trim();
  if (!key) {
    // Named, never echoed: the key is a credential.
    return { ok: false, status: 0, message: "No Bark device key is configured." };
  }
  const body = (options.body ?? "").trim();
  if (!body) {
    return { ok: false, status: 0, message: "A Bark notification needs a body." };
  }

  const server = getBarkServerUrl(env);
  const payload: Record<string, unknown> = { device_key: key, body };
  if (options.title?.trim()) payload.title = options.title.trim();
  if (options.subtitle?.trim()) payload.subtitle = options.subtitle.trim();
  if (options.group?.trim()) payload.group = options.group.trim();
  if (options.url?.trim()) payload.url = options.url.trim();
  if (options.level) payload.level = options.level;
  if (options.sound?.trim()) payload.sound = options.sound.trim();
  if (typeof options.badge === "number") payload.badge = options.badge;
  if (options.icon?.trim()) payload.icon = options.icon.trim();

  try {
    const response = await fetchFn(`${server}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let message = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as { code?: number; message?: string };
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
      if (response.ok && parsed.code !== undefined && parsed.code !== 200) {
        return { ok: false, status: response.status, message };
      }
    } catch {
      // A non-JSON body keeps its truncated text, which is more useful than
      // inventing a message.
    }
    return {
      ok: response.ok,
      status: response.status,
      message: response.ok ? message : `${redactKey(key)}: ${message}`,
    };
  } catch (error) {
    // A network failure is a normal outcome for a best-effort notification.
    return {
      ok: false,
      status: 0,
      message: `Bark server ${server} was unreachable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
