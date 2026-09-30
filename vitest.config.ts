import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Set so the tests can prove the bypass only works on localhost.
      miniflare: { bindings: { DEV_AUTH_BYPASS: "1" } },
    }),
  ],
});
