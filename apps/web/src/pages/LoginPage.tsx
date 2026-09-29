import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { beginSignIn, loadSession } from "../lib/auth/session";

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
 */
export function LoginPage() {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Someone already signed in has no business on this page.
  if (!starting && loadSession() !== null) {
    return (
      <div className="card">
        <h1>Already signed in</h1>
        <div className="notice success">This browser holds a live Twenty session.</div>
        <div className="row">
          <button type="button" className="button" onClick={() => navigate("/", { replace: true })}>
            Go to Blaster
          </button>
          <button type="button" className="button secondary" onClick={() => navigate("/cli")}>
            Authorize the CLI
          </button>
        </div>
      </div>
    );
  }

  const signIn = () => {
    setProblem(null);
    setStarting(true);
    beginSignIn().catch((error: unknown) => {
      // The happy path leaves the page, so anything that arrives here is a
      // failure worth showing rather than a silent no-op button.
      setProblem(error instanceof Error ? error.message : String(error));
      setStarting(false);
    });
  };

  return (
    <div className="card">
      <h1>Sign in</h1>
      {problem ? <div className="notice error">{problem}</div> : null}
      <div className="row">
        <button type="button" className="button" onClick={signIn} disabled={starting}>
          {starting ? "Redirecting to Twenty..." : "Continue with Twenty"}
        </button>
      </div>
      <p>
        Members are created in Twenty, not here. Signing in uses your Twenty account, so there is no Blaster
        password to create, store, or reset. The same sign-in authorizes <code>blaster</code> on this machine via{" "}
        <code>blaster login</code>.
      </p>
    </div>
  );
}
