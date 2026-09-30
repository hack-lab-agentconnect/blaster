import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TropicalTideBackground } from "../components/background-gradient/tropical-tide-background";
import { finishSignIn, loadSession } from "../lib/auth/session";
import {
  clearCliExchange,
  postCliExchange,
  readCliExchange,
  readOAuthReturn,
} from "../lib/auth/cli-handoff";

/**
 * Where Twenty returns: a plain authentication confirmation.
 *
 * The card carries only the authentication status and a way back to the main
 * page. A `blaster login` run parks a return marker, so after the code is
 * redeemed the tokens are handed to the terminal's loopback in the
 * background; that handoff reports through the same status line rather than
 * its own UI.
 */
export function CallbackPage() {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

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
        // A CLI run cannot fall back to the browser session: the whole point is
        // that the terminal gets the tokens. The handoff stays silent; the
        // card below reports the outcome the same way for every sign-in.
        const session = loadSession();
        if (!session) {
          setProblem("There was an issue connecting.");
          return;
        }
        const outcome = await postCliExchange(pending, session.tokens);
        if (cancelled) return;
        clearCliExchange();
        if (outcome.kind === "ok") setDone(true);
        else setProblem("There was an issue connecting.");
      })
      .catch(() => {
        if (!cancelled) setProblem("There was an issue connecting.");
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
            <p className="text-sm text-gray-600">There was an issue connecting.</p>
          ) : done ? (
            <>
              <p className="text-xl font-semibold text-gray-800">Your account has been authenticated.</p>
              <p className="text-sm text-gray-600">Thanks for connecting.</p>
            </>
          ) : (
            <p className="text-sm text-gray-600">Connecting your account…</p>
          )}
          <Link to="/" className="block text-center text-sm text-gray-500 underline hover:text-gray-700">
            back to the main page
          </Link>
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
