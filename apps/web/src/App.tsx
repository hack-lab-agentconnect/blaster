import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/Home";
import { CallbackPage } from "./pages/callback";
import { CliLoginPage } from "./pages/cli";
import { LoginPage } from "./pages/LoginPage";

export function App() {
  return (
    <div className="shell">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/callback" element={<CallbackPage />} />
        <Route path="/cli" element={<CliLoginPage />} />
      </Routes>
    </div>
  );
}
