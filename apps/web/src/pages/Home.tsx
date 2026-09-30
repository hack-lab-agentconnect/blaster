import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LogIn, LogOut } from "lucide-react";
import { TropicalTideBackground } from "../components/background-gradient/tropical-tide-background";
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
    // it and the landing page is only ever read. Same shell as /login.
    return (
      <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
        <div className="w-full max-w-md py-16">
          <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5">
            <h2 className="text-xl font-semibold text-gray-800">Blaster</h2>
            <p className="text-sm text-gray-500">
              Operator sign-in for the Blaster messaging pipeline. Identity comes from Twenty itself, the same user
              group that owns the workspace. Signing in here also authorizes the <code>blaster</code> CLI on this
              device via <code>blaster login</code>.
            </p>
            <Link
              to="/login"
              className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-400 text-white font-semibold py-3 rounded-lg transition"
            >
              <LogIn className="w-5 h-5" />
              Continue with Twenty
            </Link>
            <div className="text-center text-sm text-gray-500">
              <Link to="/login" className="font-medium text-brand-700 hover:text-brand-800">
                Authorize the CLI
              </Link>{" "}
              · <ConvexStatus />
            </div>
          </div>
        </div>
      </TropicalTideBackground>
    );
  }

  return (
    <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md py-16">
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5">
          <h2 className="text-xl font-semibold text-gray-800">Blaster</h2>
          <p className="text-sm text-gray-500">
            Signed in{operator?.username ? ` as ${operator.username}` : ""} through Twenty. This browser holds a live
            session; closing the tab ends it.
          </p>
          <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 p-3 rounded-lg text-sm">
            Authenticated against Twenty.
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={signOut}
              className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-400 text-white font-semibold py-3 rounded-lg transition"
            >
              <LogOut className="w-5 h-5" />
              Sign out
            </button>
            <Link
              to="/login"
              className="w-full flex items-center justify-center gap-2 bg-white hover:bg-gray-50 text-gray-700 font-semibold py-3 rounded-lg transition border border-gray-300"
            >
              Sign in as someone else
            </Link>
          </div>
          <div className="text-center text-sm text-gray-500">
            <Link to="/login" className="font-medium text-brand-700 hover:text-brand-800">
              Authorize the CLI
            </Link>{" "}
            · <ConvexStatus />
          </div>
        </div>
      </div>
    </TropicalTideBackground>
  );
}
