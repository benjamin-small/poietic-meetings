// Who is making this request? Answered from the shared poietic session
// cookie, verified against auth.poietic.tech's public key. This Worker holds
// no auth secret and can't mint tokens; see src/verify.ts.

import { verifyIdentityToken } from "./verify";

export const ISSUER = "https://auth.poietic.tech";
export const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
export const AUDIENCE = "poietic:public";
export const SESSION_COOKIE = "__Secure-poietic-session";

export interface Caller {
  sub: string;
  name: string;
}

interface AuthEnv {
  /** Local development only: see isDevBypass. Never set in production. */
  DEV_AUTH_BYPASS?: string;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The .poietic.tech cookie can't exist on localhost, so local dev needs a way
// to create rooms. Requiring BOTH the var and a localhost hostname means a
// stray production var can't open the gate on the real domain.
function isDevBypass(request: Request, env: AuthEnv): boolean {
  const host = new URL(request.url).hostname;
  return env.DEV_AUTH_BYPASS === "1" && (host === "localhost" || host === "127.0.0.1");
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
  fetchImpl?: typeof fetch,
): Promise<Caller | null> {
  if (isDevBypass(request, env)) return { sub: "dev", name: "Local dev" };
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const claims = await verifyIdentityToken(token, JWKS_URL, {
    issuer: ISSUER,
    audience: AUDIENCE,
    fetchImpl,
  });
  return claims ? { sub: claims.sub, name: claims.name } : null;
}
