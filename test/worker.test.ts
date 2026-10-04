import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exports, env } from "cloudflare:workers";
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { forbidOutboundFetch, mintToken } from "./helpers";
import { GRACE_MS, JOIN_DEADLINE_MS, MAX_PEERS, MAX_SOCKETS, STALE_MS, cleanName, type Room } from "../src/room";

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
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e: CloseEvent) => r(e.code)));
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
  return { ws, messages, waitFor, send: sendJson, closed };
}

type Welcome = Msg & { id: string; token: string; resumed: boolean; peers: { id: string; name: string }[] };

/** Connect and join (optionally resuming); resolves once the server's welcome arrives. */
async function join(room: string, name = "Guest", resume?: { id: string; token: string }) {
  const peer = await connect(room);
  peer.send({ type: "join", name, resume });
  const welcome = (await peer.waitFor("welcome")) as Welcome;
  return { ...peer, id: welcome.id, token: welcome.token, welcome };
}

const roomStub = (id: string) => env.ROOMS.get(env.ROOMS.idFromName(id));
const settle = () => new Promise((r) => setTimeout(r, 100));

/** Pretend `peerId` dropped `ms` ago, so the next sweep treats their grace as spent. */
async function ageGrace(room: string, peerId: string, ms = GRACE_MS + 1) {
  await runInDurableObject(roomStub(room), async (_i: Room, state) => {
    const p = await state.storage.get<{ goneSince?: number }>(`person:${peerId}`);
    expect(p?.goneSince).toBeTypeOf("number");
    await state.storage.put(`person:${peerId}`, { ...p, goneSince: Date.now() - ms });
  });
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

  it("rejects a tampered token whose claims are otherwise valid", async () => {
    // Every claim checks out (issuer, audience, times); only the signature
    // doesn't match, so this fails solely if signatures are verified.
    const [h, , s] = (await mintToken()).split(".");
    const [, forged] = (await mintToken({ sub: "admin" })).split(".");
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

  it("hands out ICE servers only to people who join, not over HTTP", async () => {
    const id = await newRoomId();
    expect((await call(`/chat/config?room=${id}`)).status).toBe(404);
    const a = await join(id, "A");
    const iceServers = a.welcome.iceServers as { urls: string }[];
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
    extra.send({ type: "join", name: "Extra" });
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
    const peers: Awaited<ReturnType<typeof join>>[] = [];
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
    // While anyone is present the alarm only sweeps; it never expires the room.
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true);
    expect((await call(`/chat/r/${id}`)).status).toBe(200);
  });

  it("keeps the room for its TTL when the last person drops without saying goodbye", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    a.ws.close(4000, "network lost"); // not a deliberate leave
    await vi.waitFor(async () => ageGrace(id, a.id));
    await runDurableObjectAlarm(stubFor(id)); // the sweep that lets A go
    expect((await call(`/chat/r/${id}`)).status).toBe(200);
    const alarm = await runInDurableObject(stubFor(id), (_i: Room, state) => state.storage.getAlarm());
    expect(alarm! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    // Only the TTL alarm itself deletes it.
    await runDurableObjectAlarm(stubFor(id));
    expect((await call(`/chat/r/${id}`)).status).toBe(404);
  });

  it("doesn't let a stream of events postpone the sweep", async () => {
    const id = await newRoomId();
    await join(id, "A");
    const first = await runInDurableObject(stubFor(id), (_i: Room, state) => state.storage.getAlarm());
    for (let i = 0; i < 3; i++) {
      const lurker = await connect(id);
      lurker.ws.close(4000, "churn");
      await settle();
    }
    const later = await runInDurableObject(stubFor(id), (_i: Room, state) => state.storage.getAlarm());
    expect(later).toBe(first);
  });

  it("re-arms the alarm once everyone has left", async () => {
    const id = await newRoomId();
    const a = await join(id);
    a.ws.close(1000, "bye");
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stubFor(id));
      expect((await call(`/chat/r/${id}`)).status).toBe(404);
    });
  });
});

describe("idle sockets", () => {
  it("makes room for a real visitor by evicting a socket that never joined", async () => {
    const id = await newRoomId();
    await join(id, "A");
    const lurkers = [];
    for (let i = 1; i < MAX_SOCKETS; i++) lurkers.push(await connect(id));
    const b = await join(id, "B");
    expect(b.welcome.peers.map((p) => p.name)).toEqual(["A"]);
    expect(await lurkers[0]!.closed).toBe(4003); // the longest-waiting one made way
  });

  it("lets a member resume even when the room is full of idle sockets", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    await join(id, "B");
    a.ws.close(4000, "blip");
    await settle();
    for (let i = 1; i < MAX_SOCKETS; i++) await connect(id); // B + 11 idle sockets
    const a2 = await join(id, "A", { id: a.id, token: a.token });
    expect(a2.welcome).toMatchObject({ id: a.id, resumed: true });
  });

  it("closes sockets that never join, even if they keep pinging", async () => {
    const id = await newRoomId();
    await join(id, "A");
    const lurker = await connect(id);
    lurker.ws.send('{"type":"ping"}');
    await settle();
    await runInDurableObject(roomStub(id), (_i: Room, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { id?: string; connectedAt: number };
        if (!att.id) ws.serializeAttachment({ ...att, connectedAt: Date.now() - JOIN_DEADLINE_MS - 1000 });
      }
    });
    await runDurableObjectAlarm(roomStub(id));
    expect(await lurker.closed).toBe(4003);
  });
});

describe("heartbeat", () => {
  it("answers pings without involving the room code", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const pong = new Promise<string>((r) =>
      a.ws.addEventListener("message", (e: MessageEvent) => e.data === '{"type":"pong"}' && r(e.data)),
    );
    a.ws.send('{"type":"ping"}');
    expect(await pong).toBe('{"type":"pong"}');
  });

  it("closes a connection that stopped pinging, then lets the person go after the grace period", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    await runInDurableObject(roomStub(id), (_i: Room, state) => {
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { id?: string; connectedAt: number };
        if (att.id === a.id) ws.serializeAttachment({ ...att, connectedAt: Date.now() - STALE_MS - 1000 });
      }
    });
    await runDurableObjectAlarm(roomStub(id));
    expect(await a.closed).toBe(4001);
    await settle();
    expect(b.messages.some((m) => m.type === "peer-left")).toBe(false); // still in grace
    await ageGrace(id, a.id);
    await runDurableObjectAlarm(roomStub(id));
    expect(await b.waitFor("peer-left")).toMatchObject({ id: a.id });
  });
});

describe("reconnecting", () => {
  it("lets a dropped peer rejoin silently with the same id", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    a.ws.close(4000, "network blip"); // not 1000/1001: an accidental drop
    const a2 = await join(id, "A", { id: a.id, token: a.token });
    expect(a2.welcome).toMatchObject({ id: a.id, token: a.token, resumed: true, peers: [{ id: b.id, name: "B" }] });
    // Signaling now reaches the new connection.
    b.send({ type: "offer", to: a.id, sdp: {} });
    expect(await a2.waitFor("offer")).toMatchObject({ from: b.id });
    // B never saw A leave or rejoin, even after a sweep; it's only told A is
    // back, so any unfinished call with A can restart.
    await runDurableObjectAlarm(roomStub(id));
    await settle();
    expect(b.messages.map((m) => m.type)).toEqual(["welcome", "peer-resumed"]);
    expect(b.messages[1]).toMatchObject({ id: a.id });
  });

  it("treats a wrong token as a new person", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    a.ws.close(4000, "drop");
    const imposter = await join(id, "A?", { id: a.id, token: "not-the-token" });
    expect(imposter.welcome.resumed).toBe(false);
    expect(imposter.id).not.toBe(a.id);
    expect(await b.waitFor("peer-joined")).toMatchObject({ id: imposter.id });
  });

  it("tells everyone once a dropped peer's grace period runs out", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    a.ws.close(4000, "drop");
    await vi.waitFor(async () => ageGrace(id, a.id));
    await runDurableObjectAlarm(roomStub(id));
    expect(await b.waitFor("peer-left")).toMatchObject({ id: a.id });
    // Too late to resume now: A comes back as someone new.
    const late = await join(id, "A", { id: a.id, token: a.token });
    expect(late.welcome.resumed).toBe(false);
  });

  it("completes the close handshake when the client closes", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const started = Date.now();
    const closed = new Promise<{ code: number; wasClean: boolean }>((r) =>
      a.ws.addEventListener("close", (e: CloseEvent) => r({ code: e.code, wasClean: e.wasClean })),
    );
    a.ws.close(4000, "client closing");
    const result = await closed;
    // Without a reply, clients only give up after ~10s and report 1006.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.code).toBe(4000);
  });

  it("lets someone leave from a fresh socket while their connection was down", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    a.ws.close(4000, "drop"); // A is in their grace period now
    const bye = await connect(id);
    bye.send({ type: "leave", resume: { id: a.id, token: a.token } });
    expect(await b.waitFor("peer-left")).toMatchObject({ id: a.id });
    expect(await bye.closed).toBe(1000);
  });

  it("ignores a farewell with the wrong token", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    const bye = await connect(id);
    bye.send({ type: "leave", resume: { id: a.id, token: "nope" } });
    expect(await bye.closed).toBe(1000);
    await settle();
    expect(b.messages.some((m) => m.type === "peer-left")).toBe(false);
  });

  it("a deliberate leave skips the grace period", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    a.send({ type: "leave" });
    expect(await b.waitFor("peer-left")).toMatchObject({ id: a.id });
    expect(await a.closed).toBe(1000);
  });

  it("closes the old socket when a peer resumes on a new one, without marking them gone", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    const a2 = await join(id, "A", { id: a.id, token: a.token }); // old socket still open
    expect(a2.welcome.resumed).toBe(true);
    expect(await a.closed).toBe(4002);
    await settle();
    await runInDurableObject(roomStub(id), async (_i: Room, state) => {
      expect((await state.storage.get<{ goneSince?: number }>(`person:${a.id}`))?.goneSince).toBeUndefined();
    });
    expect(b.messages.some((m) => m.type === "peer-left")).toBe(false);
  });

  it("survives the room object being reset: everyone resumes, and no-shows are let go", async () => {
    const id = await newRoomId();
    const a = await join(id, "A");
    const b = await join(id, "B");
    const c = await join(id, "C");
    await abortAllDurableObjects(); // what we suspect happened in production
    const a2 = await join(id, "A", { id: a.id, token: a.token });
    const b2 = await join(id, "B", { id: b.id, token: b.token });
    expect(a2.welcome.resumed).toBe(true);
    expect(b2.welcome.resumed).toBe(true);
    expect(a2.welcome.peers.map((p) => p.id).sort()).toEqual([b.id, c.id].sort());
    // C never comes back: the sweep notices, and after grace everyone is told.
    await runDurableObjectAlarm(roomStub(id));
    await ageGrace(id, c.id);
    await runDurableObjectAlarm(roomStub(id));
    expect(await a2.waitFor("peer-left")).toMatchObject({ id: c.id });
    expect(await b2.waitFor("peer-left")).toMatchObject({ id: c.id });
  });

  it("counts people in their grace period toward the cap", async () => {
    const id = await newRoomId();
    const peers: Awaited<ReturnType<typeof join>>[] = [];
    for (let i = 0; i < MAX_PEERS; i++) peers.push(await join(id, `P${i}`));
    peers[0]!.ws.close(4000, "drop");
    await settle();
    const extra = await connect(id);
    extra.send({ type: "join", name: "Extra" });
    await extra.waitFor("full");
    await vi.waitFor(async () => ageGrace(id, peers[0]!.id));
    await runDurableObjectAlarm(roomStub(id));
    const late = await join(id, "Late");
    expect(late.welcome.peers).toHaveLength(MAX_PEERS - 1);
  });
});

describe("client reports", () => {
  const post = (body: unknown, origin = ORIGIN) =>
    call("/chat/report", { method: "POST", headers: { origin }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("logs whitelisted fields only, clipped", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => void logged.push(line));
    const res = await post({ event: "ws-close", room: "0123456789abcdef", code: 1006, online: true, secret: "nope", peer: "x".repeat(200) });
    expect(res.status).toBe(204);
    const entry = JSON.parse(logged.find((l) => l.includes("client:ws-close"))!);
    expect(entry).toMatchObject({ event: "client:ws-close", room: "01234567", code: 1006, online: true });
    expect(entry.secret).toBeUndefined();
    expect(entry.peer).toHaveLength(64);
  });

  it("rejects other sites, unknown events, bad JSON and oversized bodies", async () => {
    expect((await post({ event: "ws-close" }, "https://evil.example")).status).toBe(403);
    expect((await post({ event: "anything" })).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ event: "ws-close", pad: "x".repeat(5000) })).status).toBe(413);
  });
});
