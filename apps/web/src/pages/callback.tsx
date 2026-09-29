import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { finishSignIn, loadSession } from "../lib/auth/session";
import {
  clearCliExchange,
  postCliExchange,
  readCliExchange,
  readOAuthReturn,
  type CliExchangeResult,
} from "../lib/auth/cli-handoff";

/**
 * Where Twenty returns, and the only other page in this app.
 *
 * A plain sign-in redeems the code and goes home. A `blaster login` run parks a
 * return marker, so the code is redeemed and then the tokens are handed to the
 * terminal's loopback rather than being kept in the browser alone, and the
 * operator is returned to the page that started it.
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

  if (exchange && !problem && !result) {
    return (
      <div className="card">
        <h1>Finishing sign-in</h1>
        <div className="notice info">Handing this session to the terminal running blaster login...</div>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Finishing sign-in</h1>
      {problem ? (
        <>
          <div className="notice error">{problem}</div>
          <div className="row">
            <button type="button" className="button" onClick={() => navigate("/", { replace: true })}>
              Back home
            </button>
          </div>
        </>
      ) : result?.kind === "ok" ? (
        <div className="notice success">Authorized. You can close this window and return to your terminal.</div>
      ) : result?.kind === "error" ? (
        <>
          <div className="notice error">{result.detail}</div>
          <div className="row">
            <button type="button" className="button" onClick={() => navigate("/", { replace: true })}>
              Back home
            </button>
          </div>
        </>
      ) : (
        <div className="notice info">Exchanging the Twenty authorization code...</div>
      )}
    </div>
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
