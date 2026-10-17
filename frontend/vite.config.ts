import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: the UI runs on :5173 and forwards API calls to the backend on :3000, so the page and the API share an
// origin and the session cookie just works. In the demo build, the backend serves frontend/dist itself.
const api = "http://localhost:3000";
const paths = ["/auth", "/me", "/portfolio", "/orders", "/trades", "/market", "/leaderboard"];

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      ...Object.fromEntries(paths.map((p) => [p, api])),
      "/ws": { target: "ws://localhost:3000", ws: true },
    },
  },
});
