import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/Home";
import { CallbackPage } from "./pages/callback";
import { LoginPage } from "./pages/LoginPage";

/**
 * Three routes, and that is the whole app.
 *
 * `/login` and `/callback` are the sign-in flow. `/login` doubles as the handoff
 * `blaster login` opens, because a separate `/cli` page would be a second
 * implementation of the same OAuth round trip, and two copies of sign-in drift.
 * Any other path is the landing page, so a stale `/cli` link from an older
 * session lands somewhere that explains itself rather than erroring.
 */
export function App() {
  return (
    <div className="shell">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </div>
  );
}
