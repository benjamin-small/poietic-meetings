import { describe, expect, it, vi } from "vitest";
import { cloudflareTurn, STUN_ONLY } from "../src/turn";

const CF_RESPONSE = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "u",
      credential: "c",
    },
  ],
};

const okFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(JSON.stringify(CF_RESPONSE), { status: 201 }));

describe("cloudflareTurn", () => {
  it("requests credentials with the key id and bearer token", async () => {
    const fetch = okFetch();
    await cloudflareTurn({ keyId: "KEY", apiToken: "TOKEN", fallback: STUN_ONLY, fetch })();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/KEY/credentials/generate-ice-servers");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(init?.body as string)).toEqual({ ttl: 86400 });
  });

  it("strips port 53 URLs, keeps the rest", async () => {
    const servers = await cloudflareTurn({ keyId: "K", apiToken: "T", fallback: STUN_ONLY, fetch: okFetch() })();
    expect(servers).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "u",
        credential: "c",
      },
    ]);
  });

  it("reuses credentials for an hour, then mints new ones", async () => {
    vi.useFakeTimers();
    try {
      const fetch = okFetch();
      const get = cloudflareTurn({ keyId: "K", apiToken: "T", fallback: STUN_ONLY, fetch });
      await get();
      await get();
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60 * 60 * 1000);
      await get();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back on API error and retries on the next call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      fail ? new Response("nope", { status: 401 }) : new Response(JSON.stringify(CF_RESPONSE), { status: 201 }),
    );
    const get = cloudflareTurn({ keyId: "K", apiToken: "T", fallback: STUN_ONLY, fetch });
    expect(await get()).toEqual(STUN_ONLY);
    fail = false;
    expect(await get()).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
