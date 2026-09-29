import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { beginSignIn, clearSession, fetchOperator, loadSession } from "../lib/auth/session";
import { ConvexStatus } from "./callback";

export function HomePage() {
  const [operator, setOperator] = useState<{ username: string | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const signedIn = loadSession() !== null;

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    fetchOperator()
      .then((result) => {
        if (!cancelled && result) setOperator({ username: result.username });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const signOut = () => {
    clearSession();
    window.location.reload();
  };

  return (
    <div className="card">
      <h1>Blaster</h1>
      <p>
        Operator sign-in for the Blaster messaging pipeline. Identity comes from Twenty itself â€” the same user
        group that owns the workspace. Signing in here also authorizes the <code>blaster</code> CLI on this
        device via <code>blaster login</code>.
      </p>
      {signedIn ? (
        <>
          <div className="notice success">
            Signed in{operator?.username ? ` as ${operator.username}` : ""} via Twenty.
          </div>
          <div className="row">
            <button type="button" className="button secondary" onClick={signOut}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <div className="row">
          <button
            type="button"
            className="button"
            disabled={starting}
            onClick={() => {
              setStarting(true);
              beginSignIn().catch(() => setStarting(false));
            }}
          >
            {starting ? "Redirectingâ€¦" : "Sign in with Twenty"}
          </button>
        </div>
      )}
      <p>
        <Link to="/cli">Authorize the CLI</Link> Â· <ConvexStatus />
      </p>
    </div>
  );
}
