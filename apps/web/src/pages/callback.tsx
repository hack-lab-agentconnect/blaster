import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { TropicalTideBackground } from "../components/background-gradient/tropical-tide-background";
import { Spokes } from "../components/ui/Spinner";
import { finishSignIn, loadSession } from "../lib/auth/session";
import {
  clearCliExchange,
  postCliExchange,
  readCliExchange,
  readOAuthReturn,
  type CliExchangeResult,
} from "../lib/auth/cli-handoff";

/**
 * Where Twenty returns.
 *
 * The plain sign-in states match open-twenty-dialer's callback page exactly:
 * a spinner while the code is redeemed, an error box with a way back on
 * failure. A `blaster login` run parks a return marker, so the code is
 * redeemed and then the tokens are handed to the terminal's loopback rather
 * than being kept in the browser alone, and those handoff states reuse the
 * same card and the same notice language.
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [exchange, setExchange] = useState(() => readCliExchange());
  const [result, setResult] = useState<CliExchangeResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    finishSignIn(window.location.search)
      .then(async () => {
        if (cancelled) return;
        const pending = readCliExchange();
        if (!pending) {
          navigate(readOAuthReturn(), { replace: true });
          return;
        }
        setExchange(pending);
        // A CLI run cannot fall back to the browser session: the whole point is
        // that the terminal gets the tokens. So this reports the outcome and
        // stays put rather than navigating away from it.
        const session = loadSession();
        if (!session) {
          setProblem("Signed in, but this browser has no session to hand over. Run blaster login again.");
          return;
        }
        const outcome = await postCliExchange(pending, session.tokens);
        if (cancelled) return;
        clearCliExchange();
        setResult(outcome);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md py-16">
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5 text-center">
          {problem ? (
            <>
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm text-left">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {problem}
              </div>
              <Link to="/login" className="inline-block text-sm font-medium text-brand-700 hover:text-brand-800">
                Back to sign in
              </Link>
            </>
          ) : result?.kind === "ok" ? (
            <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 p-3 rounded-lg text-sm text-left">
              Authorized. You can close this window and return to your terminal.
            </div>
          ) : result?.kind === "error" ? (
            <>
              <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm text-left">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {result.detail}
              </div>
              <Link to="/login" className="inline-block text-sm font-medium text-brand-700 hover:text-brand-800">
                Back to sign in
              </Link>
            </>
          ) : exchange ? (
            <>
              <Spokes className="h-8 w-8 text-brand-600 mx-auto" />
              <p className="text-sm text-gray-600">Handing this session to the terminal running blaster login…</p>
            </>
          ) : (
            <>
              <Spokes className="h-8 w-8 text-brand-600 mx-auto" />
              <p className="text-sm text-gray-600">Finishing Twenty sign-in…</p>
            </>
          )}
        </div>
      </div>
    </TropicalTideBackground>
  );
}

export function ConvexStatus() {
  const [status, setStatus] = useState<string>("checking");
  useEffect(() => {
    let cancelled = false;
    const url = import.meta.env.VITE_CONVEX_URL?.trim();
    if (!url) {
      setStatus("VITE_CONVEX_URL is not set; backend status unknown.");
      return;
    }
    const client = new ConvexReactClient(url);
    client
      .query("blaster:environment" as never, {} as never)
      .then(() => {
        if (!cancelled) setStatus("Convex deployment is reachable.");
      })
      .catch(() => {
        if (!cancelled) setStatus("Convex deployment did not answer.");
      })
      .finally(() => client.close());
    return () => {
      cancelled = true;
    };
  }, []);
  return <p>{status}</p>;
}
