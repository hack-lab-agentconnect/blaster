import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API origin the dev server proxies to. Matches the CLI's default
// --api-url and BLASTER_API_URL, so `blaster login` and the browser agree
// without anyone passing a flag.
const apiOrigin = process.env.BLASTER_API_URL ?? "http://localhost:4180";

export default defineConfig({
  plugins: [react()],
  server: {
    // Matches the CLI's default --web-url, so `blaster login` works
    // against `pnpm --filter @blaster/web dev` with no flags.
    //
    // strictPort matters more than it looks: the OAuth redirect URI is
    // registered with Twenty as http://localhost:5173/callback, and Twenty
    // rejects a consent request whose redirect_uri does not match exactly. If
    // Vite silently moved to 5174, sign-in would fail with an opaque
    // `error=invalid_request` on the callback instead of a clear message.
    port: 5173,
    strictPort: true,
    proxy: {
      // The web app talks to the API on the same origin, so the OAuth routes
      // (/api/auth/config, /token, /refresh, /me) and every read work in dev
      // without a cross-origin request and without a CORS preflight.
      "/api": { target: apiOrigin, changeOrigin: true },
    },
  },
});
