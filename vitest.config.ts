import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// A throwaway identity-provider key for the test run. The public half is
// served through the AUTH service binding exactly as poietic-auth serves its
// JWKS; the private half goes to the tests (TEST_SIGNING_JWK) to mint tokens.
const KID = "test-key";
const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID };
const privateJwk = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: KID };

export default defineConfig({
  // Worker tests only; the browser modules' tests run in Node (vitest.client.config.ts).
  test: {
    include: ["test/*.test.ts"],
    // Istanbul, because the Workers pool can't collect V8 coverage.
    coverage: { provider: "istanbul", include: ["src/**/*.ts"], reportsDirectory: "coverage/worker" },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Set so the tests can prove the bypass only works on localhost.
          DEV_AUTH_BYPASS: "1",
          TEST_SIGNING_JWK: JSON.stringify(privateJwk),
        },
        serviceBindings: {
          AUTH: async (request: Request) => {
            if (new URL(request.url).pathname === "/.well-known/jwks.json") {
              return Response.json({ keys: [publicJwk] });
            }
            return new Response("not found", { status: 404 });
          },
        },
      },
    }),
  ],
});
