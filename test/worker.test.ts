import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports, env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { mintToken, stubJwks } from "./helpers";

const ORIGIN = "https://tinkers.poietic.tech";

const call = (path: string, init?: RequestInit, origin = ORIGIN) =>
  exports.default.fetch(new Request(`${origin}${path}`, init));

async function createRoom(cookie: string | null = null, origin = ORIGIN) {
  const headers: Record<string, string> = { origin };
  if (cookie !== null) headers.cookie = cookie;
  return call("/chat/rooms", { method: "POST", headers }, origin);
}

const sessionCookie = async (overrides = {}) => `__Secure-poietic-session=${await mintToken(overrides)}`;

async function newRoomId(): Promise<string> {
  const res = await createRoom(await sessionCookie());
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** Connect to a room; collects every message the server sends. */
async function connect(room: string) {
  const res = await call(`/chat/ws?room=${room}`, { headers: { upgrade: "websocket" } });
  const ws = res.webSocket!;
  expect(ws).toBeTruthy();
  const messages: { type: string }[] = [];
  ws.accept();
  ws.addEventListener("message", (e: MessageEvent) => {
    messages.push(JSON.parse(e.data as string));
  });
  const waitFor = (type: string) =>
    vi.waitFor(() => expect(messages.map((m) => m.type)).toContain(type), { timeout: 2000 });
  return { ws, messages, waitFor };
}

beforeEach(() => {
  stubJwks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("creating a room", () => {
  it("requires a session cookie", async () => {
    const res = await createRoom();
    expect(res.status).toBe(401);
  });

  it("accepts a valid poietic session and returns a UUID room", async () => {
    const res = await createRoom(await sessionCookie());
    expect(res.status).toBe(201);
    const { id, url } = (await res.json()) as { id: string; url: string };
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(url).toBe(`/chat/r/${id}`);
  });

  it("rejects cross-site requests even with a valid cookie", async () => {
    const res = await call("/chat/rooms", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: await sessionCookie() },
    });
    expect(res.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const res = await createRoom(await sessionCookie({ iat: past - 600, exp: past }));
    expect(res.status).toBe(401);
  });

  it("rejects a token for another audience", async () => {
    const res = await createRoom(await sessionCookie({ aud: "poietic:admin" }));
    expect(res.status).toBe(401);
  });

  it("rejects a token from another issuer", async () => {
    const res = await createRoom(await sessionCookie({ iss: "https://evil.example" }));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered token", async () => {
    const token = await mintToken();
    const [h, , s] = token.split(".");
    const forged = btoa(JSON.stringify({ sub: "admin", aud: "poietic:public" })).replace(/=+$/, "");
    const res = await createRoom(`__Secure-poietic-session=${h}.${forged}.${s}`);
    expect(res.status).toBe(401);
  });

  it("dev bypass works on localhost only", async () => {
    expect((await createRoom(null, "http://localhost:8787")).status).toBe(201);
    // Same env (DEV_AUTH_BYPASS=1), production hostname: still needs a cookie.
    expect((await createRoom(null)).status).toBe(401);
  });
});

describe("room lookups", () => {
  const unknown = "00000000-0000-4000-8000-000000000000";

  it("serves the room page for an existing room", async () => {
    const id = await newRoomId();
    const res = await call(`/chat/r/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/chat/app.js");
  });

  it("404s an unknown room page", async () => {
    const res = await call(`/chat/r/${unknown}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Room not found");
  });

  it("only hands out ICE config for existing rooms", async () => {
    expect((await call(`/chat/config?room=${unknown}`)).status).toBe(404);
    expect((await call(`/chat/config?room=not-a-uuid`)).status).toBe(404);
    const id = await newRoomId();
    const res = await call(`/chat/config?room=${id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { iceServers } = (await res.json()) as { iceServers: { urls: string }[] };
    expect(iceServers[0]!.urls).toContain("stun:");
  });

  it("tells a WebSocket to an unknown room it doesn't exist", async () => {
    const { waitFor } = await connect(unknown);
    await waitFor("not-found");
  });
});

describe("signaling", () => {
  it("pairs two peers, relays signaling, rejects a third", async () => {
    const id = await newRoomId();
    const a = await connect(id);
    const b = await connect(id);
    await a.waitFor("peer-joined");

    b.ws.send(JSON.stringify({ type: "offer", sdp: { type: "offer", sdp: "x" } }));
    b.ws.send(JSON.stringify({ type: "peer-joined" })); // not relayable: dropped
    await a.waitFor("offer");
    expect(a.messages.filter((m) => m.type === "peer-joined")).toHaveLength(1);

    const c = await connect(id);
    await c.waitFor("full");
  });

  it("tells the remaining peer when the other leaves", async () => {
    const id = await newRoomId();
    const a = await connect(id);
    const b = await connect(id);
    await a.waitFor("peer-joined");
    b.ws.close(1000, "bye");
    await a.waitFor("peer-left");
  });
});

describe("expiry", () => {
  const stubFor = (id: string) => env.ROOMS.get(env.ROOMS.idFromName(id));

  it("deletes an unused room when its alarm fires", async () => {
    const id = await newRoomId();
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect((await call(`/chat/r/${id}`)).status).toBe(404);
  });

  it("keeps a room alive while someone is connected", async () => {
    const id = await newRoomId();
    await connect(id);
    // Connecting cancels the alarm, so there's nothing to run.
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(false);
    expect((await call(`/chat/r/${id}`)).status).toBe(200);
  });

  it("re-arms the alarm once everyone has left", async () => {
    const id = await newRoomId();
    const a = await connect(id);
    a.ws.close(1000, "bye");
    await vi.waitFor(async () => expect(await runDurableObjectAlarm(stubFor(id))).toBe(true));
    expect((await call(`/chat/r/${id}`)).status).toBe(404);
  });
});
