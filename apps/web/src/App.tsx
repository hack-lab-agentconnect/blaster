import { Route, Routes } from "react-router-dom";
import { HomePage } from "./pages/Home";
import { CallbackPage } from "./pages/callback";
import { CliLoginPage } from "./pages/cli";

export function App() {
  return (
    <div className="shell">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/callback" element={<CallbackPage />} />
        <Route path="/cli" element={<CliLoginPage />} />
      </Routes>
    </div>
  );
}
