import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Build the SPA straight into the Python package's static dir so the server
// serves it with no Node step on the target. Dev server proxies to the API.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../server/daq/static",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
