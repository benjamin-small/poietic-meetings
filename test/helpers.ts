// Test identity provider: an ES256 key whose public half is served as the
// auth service's JWKS, so tokens minted here verify like real ones.

import { vi } from "vitest";
import { JWKS_URL } from "../src/auth";

const KID = "test-key";
const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: KID };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const encode = (obj: object) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function mintToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", kid: KID, typ: "JWT" });
  const body = encode({
    iss: "https://auth.poietic.tech",
    aud: "poietic:public",
    sub: "user-123",
    role: "user",
    name: "Test User",
    sid: "session-1",
    iat: now,
    exp: now + 600,
    ...overrides,
  });
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keys.privateKey,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64url(new Uint8Array(sig))}`;
}

/** Serve the test JWKS; any other outbound fetch fails the test loudly. */
export function stubJwks() {
  const real = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === JWKS_URL) return Response.json({ keys: [publicJwk] });
    if (url.startsWith("https://tinkers.poietic.tech/") || url.startsWith("http://localhost")) {
      return real(input, init);
    }
    throw new Error(`Unexpected outbound fetch in test: ${url}`);
  });
}
