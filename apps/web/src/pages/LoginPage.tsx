import { useEffect, useState } from "react";
import { beginSignIn, loadSession } from "../lib/auth/session";
import { LogIn, AlertCircle } from "lucide-react";
import { TropicalTideBackground } from "../components/background-gradient/tropical-tide-background";
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
 * Identical by construction to the login page in open-twenty-dialer
 * (`frontend/src/pages/LoginPage.tsx`): same animated background, same card,
 * same button, same Tailwind stack. When the URL carries an `exchange`
 * parameter this page is also the terminal's handoff for `blaster login`,
 * and those states reuse the same card and the same notice language.
 *
 * Route shape:
 *
 *   1. GET  /api/auth/config  public discovery, no credentials
 *   2. redirect to Twenty's /authorize with S256 PKCE
 *   3. Twenty returns to /callback
 *   4. POST /api/auth/token    code + verifier, exchanged server-side
 *   5. GET  /api/auth/me       introspect, so a stored token is proven live
 */
export function LoginPage() {
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
   * A failed post clears the single-use exchange either way; a retryable
   * failure can be re-posted from the value still in state.
   */
  useEffect(() => {
    if (!exchange) return;
    const session = loadSession();
    if (!session) return;
    // StrictMode mounts, unmounts, and remounts in development: without this
    // guard the handoff posts twice and the loopback answers the second post
    // with a refusal, so a successful login ends on an error notice.
    let cancelled = false;
    const pending = exchange;
    const sessionTokens = session.tokens;
    setResult({ kind: "posting" });
    void postCliExchange(pending, { ...sessionTokens }).then((outcome) => {
      if (cancelled) return;
      setResult(outcome);
      clearCliExchange();
    });
    return () => {
      cancelled = true;
    };
  }, [exchange, attempt]);

  const isCli = exchange !== null;
  const session = loadSession();

  // A signed-in operator with a pending exchange has nothing to decide: the
  // handoff is running above, so this is only a status.
  if (isCli && session) {
    return (
      <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md py-16">
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5">
            <h2 className="text-xl font-semibold text-gray-800">Authorize the blaster CLI</h2>
            <p className="text-sm text-gray-500">
              Sending this browser&apos;s Twenty session to the terminal running <code>blaster login</code>. The
              tokens go only to that local loopback listener.
            </p>
            {result.kind === "idle" && (
              <div className="flex items-center gap-2 text-blue-700 bg-blue-50 p-3 rounded-lg text-sm">
                Preparing the local exchange...
              </div>
            )}
            {result.kind === "posting" && (
              <div className="flex items-center gap-2 text-blue-700 bg-blue-50 p-3 rounded-lg text-sm">
                <div className="w-5 h-5 border-2 border-blue-700 border-t-transparent rounded-full animate-spin" />
                Sending the session to the CLI...
              </div>
            )}
            {result.kind === "ok" && (
              <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 p-3 rounded-lg text-sm">
                Authorized. You can close this window and return to your terminal.
              </div>
            )}
            {result.kind === "error" && (
              <>
                <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {result.detail}
                </div>
                {result.retryable && exchange && (
                  <button
                    type="button"
                    onClick={() => setAttempt((n) => n + 1)}
                    className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-400 text-white font-semibold py-3 rounded-lg transition"
                  >
                    Try again
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </TropicalTideBackground>
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
    <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md py-16">
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5">
          <h2 className="text-xl font-semibold text-gray-800">{isCli ? "Sign in to authorize blaster" : "Sign In"}</h2>
          {problem && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {problem}
            </div>
          )}
          <button
            type="button"
            onClick={signIn}
            disabled={starting}
            className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-400 text-white font-semibold py-3 rounded-lg transition"
          >
            {starting ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                <LogIn className="w-5 h-5" />
                Continue with Twenty
              </>
            )}
          </button>
          <p className="text-center text-sm text-gray-500">
            Members are created in Twenty. Sign in with your Twenty account — no Blaster password needed.
            {isCli ? " Signing in here authorizes the blaster command running in your terminal." : ""}
          </p>
        </div>
      </div>
    </TropicalTideBackground>
  );
}
