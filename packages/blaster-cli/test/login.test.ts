import { describe, expect, test } from "vitest";
import { buildAuthorizeUrl, buildBrowserCommand, checkCliHandoff } from "../src/cli/login.ts";
/**
 * The web-URL check that runs before an operator is sent to a browser.
 *
 * The failure this prevents is silent and confusing: another dev server holds
 * the port, answers /login with its own home page, and the operator signs in there
 * and is told only that the exchange did not work. So the cases here are about
 * recognising the wrong app and saying what to do about it.
 */
describe("checkCliHandoff", () => {
  const html = (marker: boolean) =>
    `<!doctype html><html><head>${marker ? '<meta name="blaster-web" content="operator-sign-in" />' : "<title>Some other app</title>"}</head><body><div id="root"></div></body></html>`;

  const respond = (body: string, status = 200) =>
    (async () => new Response(body, { status, headers: { "Content-Type": "text/html" } })) as typeof fetch;

  test("accepts Blaster's own document", async () => {
    await expect(checkCliHandoff("http://localhost:5173", respond(html(true)))).resolves.toEqual({ ok: true });
  });

  test("tolerates quoting and spacing in the marker", async () => {
    const spaced = `<meta name='blaster-web' content='x'>`;
    await expect(checkCliHandoff("http://localhost:5173", respond(spaced))).resolves.toEqual({ ok: true });
  });

  test("refuses another app, and names the port and the fix", async () => {
    const result = await checkCliHandoff("http://localhost:5173", respond(html(false)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The port is the actionable part: whoever holds it is why this failed.
    expect(result.message).toContain("port 5173");
    expect(result.message).toContain("pnpm --filter @blaster/web dev");
    expect(result.message).not.toContain("blaster-web\" content");
  });

  test("asks for the web app to be started when nothing answers", async () => {
    const dead = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const result = await checkCliHandoff("http://localhost:5173", dead);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("nothing is serving");
    expect(result.message).toContain("pnpm --filter @blaster/web dev");
  });

  test("asks for the port from the URL rather than assuming 5173", async () => {
    const result = await checkCliHandoff("http://localhost:4321", respond(html(false)));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("port 4321");
  });

  test("the probe asks for /login, the app's only sign-in page", async () => {
    const url = buildAuthorizeUrl("http://localhost:5173", "st-1", "ch-1", "http://127.0.0.1:5555/exchange");
    // No CLI-specific route: a second page for the same flow is a second copy to keep in step.
    expect(new URL(url).pathname).toBe("/login");
    expect(url).toContain("state=st-1");
    expect(url).toContain("code_challenge=ch-1");
    expect(url).toContain(encodeURIComponent("http://127.0.0.1:5555/exchange"));
  });

  test("a trailing slash on the web URL does not double up the path", async () => {
    const seen: string[] = [];
    const spy = (async (url: string) => {
      seen.push(String(url));
      return new Response(html(true), { status: 200 });
    }) as unknown as typeof fetch;
    await checkCliHandoff("http://localhost:5173/", spy);
    expect(seen[0]).toBe("http://localhost:5173/login");
  });
});

describe("buildBrowserCommand", () => {
  const url =
    "https://blaster-web-nine.vercel.app/login?state=st-1&code_challenge=ch-1&exchange=" +
    encodeURIComponent("http://127.0.0.1:5555/exchange");

  test("Windows quotes the URL so cmd keeps every query parameter", () => {
    // Unquoted, cmd.exe splits on & and the browser opens ?state=... alone:
    // no exchange reaches the page and the terminal waits out the timeout.
    const { command, args } = buildBrowserCommand(url, "win32");
    expect(command).toBe("cmd");
    expect(args).toEqual(["/c", "start", "", `"${url}"`]);
  });

  test("macOS and Linux take the URL as a single argv entry", () => {
    expect(buildBrowserCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(buildBrowserCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
  });
});