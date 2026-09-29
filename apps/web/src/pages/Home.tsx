import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { clearSession, fetchOperator, loadSession } from "../lib/auth/session";
import { ConvexStatus } from "./callback";

export function HomePage() {
  const [operator, setOperator] = useState<{ username: string | null } | null>(null);
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

  if (!signedIn) {
    // The sign-in action lives on its own page, so there is one place that owns
    // it and the landing page is only ever read.
    return (
      <div className="card">
        <h1>Blaster</h1>
        <p>
          Operator sign-in for the Blaster messaging pipeline. Identity comes from Twenty itself, the same user
          group that owns the workspace. Signing in here also authorizes the <code>blaster</code> CLI on this
          device via <code>blaster login</code>.
        </p>
        <div className="row">
          <Link className="button" to="/login">
            Continue with Twenty
          </Link>
        </div>
        <p>
          <Link to="/login">Authorize the CLI</Link> · <ConvexStatus />
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h1>Blaster</h1>
      <p>
        Signed in{operator?.username ? ` as ${operator.username}` : ""} through Twenty. This browser holds a live
        session; closing the tab ends it.
      </p>
      <div className="notice success">Authenticated against Twenty.</div>
      <div className="row">
        <button type="button" className="button secondary" onClick={signOut}>
          Sign out
        </button>
        <Link className="button secondary" to="/login">
          Sign in as someone else
        </Link>
      </div>
      <p>
        <Link to="/login">Authorize the CLI</Link> · <ConvexStatus />
      </p>
    </div>
  );
}
