/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Ports come from the repo's .env, which the Makefile exports.
const webPort = Number(process.env.WEB_PORT ?? 5173);
// Keep the browser's Host header: the backend's CSRF check compares it with
// Origin. (A plain string target would turn on changeOrigin.)
const apiTarget = {
  target: `http://localhost:${process.env.API_PORT ?? "8080"}`,
  changeOrigin: false,
};

// The commit shown in About: GIT_COMMIT from the image build (the Docker
// context has no .git), else the checkout's.
function gitCommit(): string {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_COMMIT__: JSON.stringify(gitCommit()) },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    rolldownOptions: {
      // Dependencies change less often than app code, so cache them apart.
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules\/(react|react-dom|react-router|scheduler)\//,
              priority: 2,
            },
            { name: "vendor", test: /node_modules/, priority: 1 },
          ],
        },
      },
    },
  },
  server: {
    port: webPort,
    strictPort: true,
    // Report PDFs in dev (#127): the Chrome container loads the print page
    // from host.docker.internal, so Vite listens on VITE_HOST (0.0.0.0)
    // when it's set, else on localhost only.
    host: process.env.VITE_HOST ?? "localhost",
    allowedHosts: ["host.docker.internal"],
    // Same-origin API calls in dev, so session cookies just work.
    proxy: {
      "/api": apiTarget,
      "/healthz": apiTarget,
      "/readyz": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // West of UTC, so date bugs (UTC midnight read as the previous day) show up.
    env: { TZ: "America/Los_Angeles" },
  },
});
