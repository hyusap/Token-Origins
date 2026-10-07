import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Opt-in share mode: serves the canvas on every interface so a tailnet peer can
 * open it, while still presenting the backend the localhost host and origin its
 * access check requires. The backend's allowlist is deliberately left alone.
 *
 * This exposes the semantic tool endpoints to anyone who can reach this machine,
 * so run it on a private tailnet only, never on an untrusted network.
 */
const localOrigin = "http://127.0.0.1:5173";
const rewriteOrigin = (proxy: any) =>
  proxy.on("proxyReq", (proxyReq: any) => proxyReq.setHeader("origin", localOrigin));

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174,
    strictPort: true,
    // Vite rejects unknown Host headers, which blocks the tailnet DNS name.
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4318",
        changeOrigin: true,
        configure: rewriteOrigin,
      },
      "/ws": {
        target: "ws://127.0.0.1:4318",
        ws: true,
        changeOrigin: true,
        configure: rewriteOrigin,
      },
    },
  },
});
