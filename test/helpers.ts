// Mints tokens with the test key from vitest.config.ts, whose public half the
// AUTH service binding serves as poietic-auth's JWKS.

import { vi } from "vitest";
import { env } from "cloudflare:workers";

const privateJwk = JSON.parse((env as unknown as { TEST_SIGNING_JWK: string }).TEST_SIGNING_JWK);
const privateKey = await crypto.subtle.importKey(
  "jwk",
  privateJwk,
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign"],
);

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (obj: object) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function mintToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: privateJwk.kid, typ: "JWT", ...(overrides.header as object) });
  const { header: _, ...claims } = overrides;
  const body = encode({
    iss: "https://auth.poietic.tech",
    aud: "poietic:public",
    sub: "user-123",
    role: "user",
    name: "Test User",
    sid: "session-1",
    iat: now,
    exp: now + 600,
    ...claims,
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

/**
 * Fail any public-internet fetch. In production a subrequest to
 * auth.poietic.tech lands on a placeholder origin, so the JWKS must come
 * through the AUTH binding; a regression to plain fetch fails loudly here.
 */
export function forbidOutboundFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
}
