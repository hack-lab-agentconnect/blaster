/**
 * /cli â€” the browser half of `blaster login`.
 *
 * The CLI opens this page with `?state=â€¦&code_challenge=â€¦&exchange=â€¦`, where
 * exchange is the one-shot loopback URL it is listening on. Once the viewer
 * holds a Twenty operator session, the page posts the Twenty tokens back to
 * the CLI. The CLI accepts the exchange only when the state and
 * code_challenge match the run it started, binding the exchange to that
 * terminal; the tokens themselves were minted by Twenty, never by us.
 *
 * Exchange params are mirrored into sessionStorage on arrival, because the
 * Twenty round trip does not preserve our query string. Routing:
 *
 *   no params, nothing stored  -> nothing pending; ask for a fresh run
 *   params, no Twenty session  -> sign in with Twenty, return here, exchange
 *   params, Twenty session     -> post the tokens, report the outcome
 *
 * Tokens are never displayed; the exchange response renders as ok/fail.
 */

import { useCallback, useEffect, useState } from "react";
import { beginSignIn, loadSession } from "../lib/auth/session";

type CliLoginResult =
  | { kind: "idle" | "posting" }
  | { kind: "ok" }
  | { kind: "error"; detail: string; terminal: boolean };

interface PendingExchange {
  state: string;
  codeChallenge: string;
  exchangeUrl: string;
}

const STORAGE_KEY = "blaster.cli.exchange";
const RETURN_KEY = "blaster.oauth.return";
const EXCHANGE_RE = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/exchange$/;

function isPending(value: unknown): value is PendingExchange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PendingExchange>;
  return (
    typeof candidate.state === "string" &&
    candidate.state !== "" &&
    typeof candidate.codeChallenge === "string" &&
    candidate.codeChallenge !== "" &&
    typeof candidate.exchangeUrl === "string" &&
    EXCHANGE_RE.test(candidate.exchangeUrl)
  );
}

function readExchangeFromUrl(): PendingExchange | null {
  const params = new URLSearchParams(window.location.search);
  const candidate = {
    state: params.get("state") ?? "",
    codeChallenge: params.get("code_challenge") ?? "",
    exchangeUrl: params.get("exchange") ?? "",
  };
  return isPending(candidate) ? candidate : null;
}

function readStoredExchange(): PendingExchange | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPending(parsed)) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function CliLoginPage() {
  const [result, setResult] = useState<CliLoginResult>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);

  const [pending] = useState<PendingExchange | null>(() => {
    const fromUrl = readExchangeFromUrl();
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(fromUrl));
      } catch {
        // Private-mode denial only costs the post-sign-in recovery path.
      }
      return fromUrl;
    }
    return readStoredExchange();
  });

  const postExchange = useCallback(
    async (exchange: PendingExchange, session: { accessToken: string; refreshToken: string | null; expiresIn: number | null }): Promise<boolean> => {
      setResult({ kind: "posting" });
      try {
        const response = await fetch(exchange.exchangeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: exchange.state,
            code_challenge: exchange.codeChallenge,
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
            expires_in: session.expiresIn,
            token_type: "Bearer",
          }),
        });
        const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (response.ok && body.ok) {
          setResult({ kind: "ok" });
          return true;
        }
        const retryable = response.status === 401;
        setResult({
          kind: "error",
          detail: body.error ?? `The CLI rejected the exchange (HTTP ${response.status}).`,
          terminal: !retryable,
        });
        return !retryable;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setResult({
          kind: "error",
          detail: `Could not reach the CLI at ${exchange.exchangeUrl}. It may have finished or timed out â€” run \`blaster login\` again. (${message})`,
          terminal: true,
        });
        return true;
      }
    },
    [],
  );

  // The Twenty round trip drops our query string, so the CLI params survive
  // in the session mirror and the return marker brings the callback back
  // here instead of home.
  const signInAndReturn = useCallback(() => {
    try {
      window.sessionStorage.setItem(RETURN_KEY, `${window.location.pathname}${window.location.search}`);
    } catch {
      // Without the marker the user lands home and can reopen the CLI URL.
    }
    void beginSignIn();
  }, []);

  useEffect(() => {
    if (!pending) return;
    const session = loadSession();
    if (!session) {
      signInAndReturn();
      return;
    }
    setResult({ kind: "idle" });
    let cancelled = false;
    void postExchange(pending, session.tokens).then((spent) => {
      if (cancelled) return;
      // Only forget the pending run once the listener is actually spent.
      if (spent) {
        try {
          window.sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          // Nothing to do.
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pending, postExchange, signInAndReturn, attempt]);

  if (!pending) {
    return (
      <div className="card">
        <h1>Authorize blaster CLI</h1>
        <div className="notice info">
          This page was opened without a <code>blaster login</code> code, so there is nothing to authorize yet. Run{" "}
          <code>blaster login</code> in your terminal and open the URL it prints.
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Authorize blaster CLI</h1>
      <p>
        Sign in with Twenty to connect the <code>blaster</code> command on this device. Your Twenty tokens are sent
        only to the local loopback listener started by <code>blaster login</code> â€” never to a web server.
      </p>
      <div role="status" aria-live="polite">
        {result.kind === "idle" && <div className="notice info">Preparing the local exchangeâ€¦</div>}
        {result.kind === "posting" && <div className="notice info">Sending the session proof to the CLI (127.0.0.1)â€¦</div>}
        {result.kind === "ok" && (
          <div className="notice success">Authorized. You can close this window and return to your terminal.</div>
        )}
        {result.kind === "error" && (
          <div>
            <div className="notice error">{result.detail}</div>
            {!result.terminal && (
              <div className="row">
                <button type="button" className="button secondary" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function readOAuthReturn(): string {
  try {
    const target = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    if (target && target.startsWith("/")) return target;
  } catch {
    // Fall through to home.
  }
  return "/";
}
