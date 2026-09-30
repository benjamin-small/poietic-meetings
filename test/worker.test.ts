import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports, env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { forbidOutboundFetch, mintToken } from "./helpers";
import { MAX_PEERS, cleanName } from "../src/room";

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

type Msg = { type: string; [k: string]: unknown };

/** Open a socket to a room; collects every message the server sends. */
async function connect(room: string) {
  const res = await call(`/chat/ws?room=${room}`, { headers: { upgrade: "websocket" } });
  const ws = res.webSocket!;
  expect(ws).toBeTruthy();
  const messages: Msg[] = [];
  ws.accept();
  ws.addEventListener("message", (e: MessageEvent) => {
    messages.push(JSON.parse(e.data as string));
  });
  const waitFor = (type: string, count = 1) =>
    vi.waitFor(
      () => {
        const found = messages.filter((m) => m.type === type);
        expect(found.length).toBeGreaterThanOrEqual(count);
        return found[count - 1]!;
      },
      { timeout: 2000 },
    );
  const sendJson = (msg: object) => ws.send(JSON.stringify(msg));
  return { ws, messages, waitFor, send: sendJson };
}

/** Connect and join; resolves once the server's welcome arrives. */
async function join(room: string, name = "Guest") {
  const peer = await connect(room);
  peer.send({ type: "join", name });
  const welcome = (await peer.waitFor("welcome")) as Msg & { id: string; peers: { id: string; name: string }[] };
  return { ...peer, id: welcome.id, welcome };
}

beforeEach(() => {
  forbidOutboundFetch();
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

  it("rejects a token signed with a key the JWKS doesn't have", async () => {
    // The production bug: an unknown kid forces a JWKS refetch, which used to
    // go over plain fetch and crash the Worker (1101) instead of a 401.
    const res = await createRoom(await sessionCookie({ header: { kid: "unknown-kid" } }));
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
  it("welcomes each newcomer with the peers already present", async () => {
    const id = await newRoomId();
    const a = await join(id, "Ada");
    expect(a.welcome.peers).toEqual([]);
    const b = await join(id, "Bo");
    expect(b.welcome.peers).toEqual([{ id: a.id, name: "Ada" }]);
    expect(await a.waitFor("peer-joined")).toMatchObject({ id: b.id, name: "Bo" });
    const c = await join(id, "Cy");
    expect(c.welcome.peers).toEqual(
      expect.arrayContaining([
        { id: a.id, name: "Ada" },
        { id: b.id, name: "Bo" },
      ]),
    );
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it("relays only to the addressed peer, with a server-set `from`", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    const c = await join(id, "C");
    // C claims to be A; the server must overwrite that.
    c.send({ type: "offer", to: a.id, from: b.id, sdp: { type: "offer", sdp: "x" } });
    expect(await a.waitFor("offer")).toMatchObject({ from: c.id, to: a.id });
    c.send({ type: "candidate", to: b.id, candidate: { candidate: "c" } });
    await b.waitFor("candidate");
    expect(b.messages.some((m) => m.type === "offer")).toBe(false);
    expect(a.messages.some((m) => m.type === "candidate")).toBe(false);
  });

  it("ignores relays before join, to unknown peers, and non-relay types", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const lurker = await connect(id);
    lurker.send({ type: "offer", to: a.id, sdp: {} }); // not joined yet
    const b = await join(id, "B");
    b.send({ type: "offer", to: "nobody", sdp: {} });
    b.send({ type: "peer-left", to: a.id, id: "x" }); // not a relay type
    b.send({ type: "answer", to: a.id, sdp: {} }); // this one is real
    await a.waitFor("answer");
    expect(a.messages.map((m) => m.type)).toEqual(["welcome", "peer-joined", "answer"]);
  });

  it("only joins once", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    b.send({ type: "join", name: "B again" });
    a.send({ type: "offer", to: b.id, sdp: {} });
    await b.waitFor("offer");
    expect(b.messages.filter((m) => m.type === "welcome")).toHaveLength(1);
    expect(a.messages.filter((m) => m.type === "peer-joined")).toHaveLength(1);
  });

  it(`holds ${MAX_PEERS} people and turns the next one away`, async () => {
    const id = await newRoomId();
    for (let i = 0; i < MAX_PEERS; i++) await join(id, `P${i}`);
    const extra = await connect(id);
    await extra.waitFor("full");
  });

  it("tells everyone else when a peer leaves", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    const c = await join(id, "C");
    b.ws.close(1000, "bye");
    expect(await a.waitFor("peer-left")).toMatchObject({ id: b.id });
    expect(await c.waitFor("peer-left")).toMatchObject({ id: b.id });
  });

  it("frees a slot when someone leaves", async () => {
    const id = await newRoomId();
    const peers = [];
    for (let i = 0; i < MAX_PEERS; i++) peers.push(await join(id, `P${i}`));
    peers[0]!.ws.close(1000, "bye");
    await peers[1]!.waitFor("peer-left");
    const late = await join(id, "Late");
    expect(late.welcome.peers).toHaveLength(MAX_PEERS - 1);
  });
});

describe("cleanName", () => {
  it("trims, strips control characters and caps length", () => {
    expect(cleanName("  Ada  ")).toBe("Ada");
    expect(cleanName("A\u0000d\na\u007f")).toBe("Ada");
    expect(cleanName("x".repeat(100))).toHaveLength(32);
  });

  it("falls back to Guest for empty or missing names", () => {
    expect(cleanName("")).toBe("Guest");
    expect(cleanName("   ")).toBe("Guest");
    expect(cleanName(undefined)).toBe("Guest");
    expect(cleanName(null)).toBe("Guest");
  });

  it("keeps HTML-looking names as text (the client renders with textContent)", () => {
    expect(cleanName("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
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
    await join(id);
    // Connecting cancels the alarm, so there's nothing to run.
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(false);
    expect((await call(`/chat/r/${id}`)).status).toBe(200);
  });

  it("re-arms the alarm once everyone has left", async () => {
    const id = await newRoomId();
    const a = await join(id);
    a.ws.close(1000, "bye");
    await vi.waitFor(async () => expect(await runDurableObjectAlarm(stubFor(id))).toBe(true));
    expect((await call(`/chat/r/${id}`)).status).toBe(404);
  });
});
