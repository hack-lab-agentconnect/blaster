import { ConvexReactClient } from "convex/react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { finishSignIn } from "../lib/auth/session";
import { readOAuthReturn } from "./cli";

export function CallbackPage() {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    finishSignIn(window.location.search)
      .then(() => {
        // The CLI flow parks a return marker so the Twenty round trip lands
        // back on /cli; plain sign-ins land home.
        if (!cancelled) navigate(readOAuthReturn(), { replace: true });
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="card">
      <h1>Finishing sign-inâ€¦</h1>
      {problem ? (
        <>
          <div className="notice error">{problem}</div>
          <div className="row">
            <button type="button" className="button" onClick={() => navigate("/", { replace: true })}>
              Back home
            </button>
          </div>
        </>
      ) : (
        <div className="notice info">Exchanging the Twenty authorization codeâ€¦</div>
      )}
    </div>
  );
}

export function ConvexStatus() {
  const [status, setStatus] = useState<string>("checkingâ€¦");
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
