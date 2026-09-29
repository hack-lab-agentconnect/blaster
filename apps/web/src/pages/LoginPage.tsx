import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { beginSignIn, loadSession } from "../lib/auth/session";
import {
  clearCliExchange,
  markOAuthReturn,
  postCliExchange,
  readCliExchange,
  type CliExchangeResult,
} from "../lib/auth/cli-handoff";

/**
 * The one sign-in page.
 *
 * Ported from the Vercel site's login page in open-twenty-dialer
 * (`frontend/src/pages/LoginPage.tsx`), which gets the shape right: a single
 * page, a single action, and an honest statement that the account lives in
 * Twenty. What is not ported is its furniture: it renders through Tailwind and
 * `lucide-react`, and this app has neither. Adding a CSS framework and an icon
 * package to reproduce one button would be a worse trade than matching the
 * classes this app already has.
 *
 * The route shape is identical, which is the part that matters:
 *
 *   1. GET  /api/auth/config  public discovery, no credentials
 *   2. redirect to Twenty's /authorize with S256 PKCE
 *   3. Twenty returns to /callback
 *   4. POST /api/auth/token    code + verifier, exchanged server-side
 *   5. GET  /api/auth/me       introspect, so a stored token is proven live
 *
 * Blaster keeps `/api/auth/*` rather than that repo's `/api/oauth/*`. The
 * shape is the same and the difference is only a prefix, but renaming it would
 * break `blaster login`, the CLI's token validation, and this app, for no gain.
 *
 * It is also the page `blaster login` opens. When the URL carries an `exchange`
 * parameter this page is the terminal's handoff as well as a sign-in form, and
 * after the round trip it hands the tokens to the loopback rather than just
 * showing that it worked. There is no separate CLI page: a second route would be
 * a second implementation of this flow, and two copies of sign-in drift.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [exchange, setExchange] = useState(() => readCliExchange());
  const [result, setResult] = useState<CliExchangeResult>({ kind: "idle" });
  const [attempt, setAttempt] = useState(0);

  /**
   * Hand the live session to the terminal.
   *
   * Runs whenever a session exists and an exchange is pending, which covers both
   * orders: an operator who was already signed in when they opened the CLI URL,
   * and one who signed in through this page and came back from /callback.
   */
  const deliver = useCallback(
    (pending: NonNullable<typeof exchange>, session: NonNullable<ReturnType<typeof loadSession>>) => {
      setResult({ kind: "posting" });
      void postCliExchange(pending, session.tokens).then((outcome) => {
        setResult(outcome);
        // The exchange is single-use, so the mirror is cleared either way; a
        // retryable failure can be re-posted from the value still in state.
        clearCliExchange();
      });
    },
    [],
  );

  useEffect(() => {
    if (!exchange) return;
    const session = loadSession();
    if (!session) return;
    deliver(exchange, session);
  }, [exchange, deliver, attempt]);

  const isCli = exchange !== null;
  const session = loadSession();

  // A signed-in operator with a pending exchange has nothing to decide: the
  // handoff is running above, so this is only a status.
  if (isCli && session) {
    return (
      <div className="card">
        <h1>Authorize the blaster CLI</h1>
        <p>
          Sending this browser&apos;s Twenty session to the terminal running <code>blaster login</code>. The
          tokens go only to that local loopback listener.
        </p>
        <div role="status" aria-live="polite">
          {result.kind === "idle" && <div className="notice info">Preparing the local exchange...</div>}
          {result.kind === "posting" && <div className="notice info">Sending the session to the CLI...</div>}
          {result.kind === "ok" && (
            <div className="notice success">Authorized. You can close this window and return to your terminal.</div>
          )}
          {result.kind === "error" && (
            <div>
              <div className="notice error">{result.detail}</div>
              {result.retryable && exchange && (
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

  const signIn = () => {
    setProblem(null);
    setStarting(true);
    // Recorded before leaving, because the Twenty round trip drops the query
    // string and /callback needs to know to come back here with the exchange.
    if (isCli) markOAuthReturn();
    beginSignIn().catch((error: unknown) => {
      // The happy path leaves the page, so anything that arrives here is a
      // failure worth showing rather than a silent no-op button.
      setProblem(error instanceof Error ? error.message : String(error));
      setStarting(false);
    });
  };

  return (
    <div className="card">
      <h1>{isCli ? "Sign in to authorize blaster" : "Sign in"}</h1>
      {problem ? <div className="notice error">{problem}</div> : null}
      <div className="row">
        <button type="button" className="button" onClick={signIn} disabled={starting}>
          {starting ? "Redirecting to Twenty..." : "Continue with Twenty"}
        </button>
      </div>
      <p>
        Members are created in Twenty, not here. Signing in uses your Twenty account, so there is no Blaster
        password to create, store, or reset.
        {isCli ? (
          <>
            {" "}
            Signing in here authorizes the <code>blaster</code> command running in your terminal.
          </>
        ) : (
          <>
            {" "}
            The same sign-in authorizes <code>blaster</code> on this machine via <code>blaster login</code>.
          </>
        )}
      </p>
    </div>
  );
}
