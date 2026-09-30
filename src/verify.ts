// Vendored verbatim from benjamin-small/poietic-dot-tech packages/identity/verify.ts
// (commit a76beae). Keep in sync by re-copying, not by editing here.

/**
 * Verify a poietic identity token.
 *
 * Shared by every service that needs to know who a visitor is. It holds NO
 * secret: verification uses the public key published at the auth service's
 * JWKS endpoint, so a service can authenticate a caller while being
 * incapable of minting a token for anyone. That asymmetry is the whole
 * reason the tokens are ES256 rather than an HMAC.
 *
 * Deliberately dependency-free (WebCrypto only) so it drops into any Worker.
 */

export interface IdentityClaims {
  iss: string;
  sub: string;
  aud: string;
  role: string;
  /** The name to print for this user, fixed when the token was issued. */
  name: string;
  sid: string;
  iat: number;
  exp: number;
}

export interface VerifyOptions {
  issuer: string;
  audience: string;
  now?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const s = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

let cache: CachedKeys | null = null;

/** JWKS is cached in module scope for the isolate's life. Key rotation
 *  publishes a new `kid`, and an unknown kid forces a refetch below — so a
 *  rotation is picked up without waiting for this TTL to lapse. */
const JWKS_TTL_MS = 3600_000;

async function loadKeys(jwksUrl: string, fetchImpl: typeof fetch, force: boolean): Promise<Map<string, CryptoKey>> {
  const fresh = cache && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (cache && fresh && !force) return cache.keys;

  const res = await fetchImpl(jwksUrl);
  if (!res.ok) {
    // Serve stale rather than failing every request if the auth service is
    // briefly unreachable — the keys are still cryptographically valid.
    if (cache) return cache.keys;
    throw new Error(`jwks fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    const kid = (jwk as { kid?: string }).kid;
    if (!kid) continue;
    try {
      keys.set(
        kid,
        await crypto.subtle.importKey(
          "jwk",
          { ...jwk, key_ops: ["verify"] },
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["verify"],
        ),
      );
    } catch {
      // A malformed key in the set must not poison the usable ones.
    }
  }
  cache = { keys, fetchedAt: Date.now() };
  return keys;
}

/** Exposed for tests; production code should never need it. */
export function resetKeyCache(): void {
  cache = null;
}

/**
 * Returns the claims if the token is genuine and currently valid, else null.
 * Null is the only failure signal on purpose: a caller cannot accidentally
 * use an unverified payload it was handed alongside an error flag.
 */
export async function verifyIdentityToken(
  token: string,
  jwksUrl: string,
  opts: VerifyOptions,
): Promise<IdentityClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [rawHeader, rawBody, rawSig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(rawHeader)));
  } catch {
    return null;
  }
  // Only ES256. Rejecting by allowlist stops the alg-confusion family of
  // attacks, including alg=none.
  if (header.alg !== "ES256" || !header.kid) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  let keys = await loadKeys(jwksUrl, fetchImpl, false);
  let key = keys.get(header.kid);
  if (!key) {
    // Unknown kid: the signing key may have rotated since we cached. Refetch
    // once before rejecting, so a rotation doesn't fail every login for an
    // hour.
    keys = await loadKeys(jwksUrl, fetchImpl, true);
    key = keys.get(header.kid);
  }
  if (!key) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64urlDecode(rawSig) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${rawHeader}.${rawBody}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  let claims: IdentityClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(rawBody)));
  } catch {
    return null;
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (claims.iss !== opts.issuer) return null;
  if (claims.aud !== opts.audience) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now) return null;
  if (typeof claims.iat !== "number" || claims.iat > now + 60) return null;
  return claims;
}
