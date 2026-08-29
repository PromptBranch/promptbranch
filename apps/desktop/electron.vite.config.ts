import fs from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

// App version injected into the main bundle at build time: app.getVersion()
// falls back to the *Electron* version when it cannot locate the app's
// package.json (seen in some dev runs showing "v43.x" in the footer).
const APP_VERSION = (JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * Dev-only CSP relaxation. The production index.html pins the inline theme
 * bootstrap by sha256 hash and allows no other inline scripts — but
 * @vitejs/plugin-react injects an inline fast-refresh preamble in dev, which
 * the hash-only script-src would block. Swap the hash for 'unsafe-inline' in
 * serve mode only; builds keep the strict policy.
 */
function devCspPlugin(): Plugin {
  return {
    name: "dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace(/'sha256-[A-Za-z0-9+/=]+'/, "'unsafe-inline'");
    },
  };
}

export default defineConfig({
  main: {
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    // Bundle the workspace packages (TypeScript source) into the main
    // process; keep native/external deps (better-sqlite3) external. The AI
    // SDK packages are deps of @promptbranch/ai (not of this package), so
    // they are pure-JS and get bundled by default.
    plugins: [externalizeDepsPlugin({ exclude: ["@promptbranch/core", "@promptbranch/ai", "@promptbranch/share"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), devCspPlugin()],
  },
});
