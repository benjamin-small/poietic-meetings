import { defineConfig } from "vitest/config";

// The browser modules in public/chat, tested in Node against fakes
// (test/client/fakes.js). The Worker tests use vitest.config.ts instead.
export default defineConfig({
  test: {
    include: ["test/client/**/*.test.js"],
    environment: "node",
  },
});
