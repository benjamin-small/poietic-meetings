import { defineConfig } from "vitest/config";

// The browser modules in public/chat, tested in Node against fakes
// (test/client/fakes.js). The Worker tests use vitest.config.ts instead.
export default defineConfig({
  // The modules under test live in public/, which Vite would otherwise treat
  // as static assets and refuse to instrument for coverage.
  publicDir: false,
  test: {
    include: ["test/client/**/*.test.js"],
    environment: "node",
    coverage: { provider: "istanbul", include: ["public/chat/**/*.js"], reportsDirectory: "coverage/client" },
  },
});
