import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The browser modules in public/chat, tested in Node against fakes
// (test/client/fakes.js). The page scripts (app.js, lobby.js) run in
// happy-dom instead; see test/client/page.js. The Worker tests use
// vitest.config.ts.
export default defineConfig({
  // The modules under test live in public/, which Vite would otherwise treat
  // as static assets and refuse to instrument for coverage.
  publicDir: false,
  resolve: {
    // The pages import each other by their served paths (/chat/mesh.js).
    alias: [{ find: /^\/chat\/(.*)$/, replacement: fileURLToPath(new URL("./public/chat/$1", import.meta.url)) }],
  },
  test: {
    include: ["test/client/**/*.test.js"],
    environment: "node",
    coverage: { provider: "istanbul", include: ["public/chat/**/*.js"], reportsDirectory: "coverage/client" },
  },
});
