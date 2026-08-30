import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The React plugin gives test files the automatic JSX runtime (no `import
// React` needed). Environments are chosen per file: node by default (main /
// lib logic tests), `// @vitest-environment jsdom` for component tests.
export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["src/renderer/src/test/setup.ts"],
  },
});
