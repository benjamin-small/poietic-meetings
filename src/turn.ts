// Mints short-lived Cloudflare TURN credentials so no long-lived TURN
// secret ever reaches the browser.
// Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const STUN_ONLY: IceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

// Long enough to outlast a call (TURN allocations refresh with the same
// credential), short enough to limit reuse outside the app.
const CREDENTIAL_TTL = 6 * 60 * 60; // seconds each credential stays valid
const REUSE_FOR = 60 * 60 * 1000; // ms to share one credential between people in a room

interface Options {
  keyId: string;
  apiToken: string;
  fallback: IceServer[];
  fetch?: typeof fetch;
}

/**
 * Returns a `getIceServers()` function that fetches Cloudflare credentials,
 * caches them briefly, and falls back to `fallback` if the API fails.
 */
export function cloudflareTurn({ keyId, apiToken, fallback, fetch: fetchImpl = fetch }: Options) {
  let cached: IceServer[] | null = null;
  let cachedAt = 0;

  async function mint(): Promise<IceServer[]> {
    const res = await fetchImpl(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) throw new Error(`Cloudflare TURN API responded ${res.status}`);
    const { iceServers } = (await res.json()) as { iceServers: IceServer[] };
    return withoutPort53(iceServers);
  }

  return async function getIceServers(): Promise<IceServer[]> {
    if (cached && Date.now() - cachedAt < REUSE_FOR) return cached;
    try {
      cached = await mint();
      cachedAt = Date.now();
      return cached;
    } catch (err) {
      console.error("TURN credential fetch failed, using fallback:", (err as Error).message);
      return fallback;
    }
  };
}

// Browsers block port 53, and those URLs just time out during ICE gathering.
function withoutPort53(iceServers: IceServer[]): IceServer[] {
  return iceServers
    .map((s) => ({ ...s, urls: ([] as string[]).concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
}
