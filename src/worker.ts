// tinkers.poietic.tech: a hub for small experiments. Chat lives under /chat.
//
//   GET  /chat/r/:uuid       room page (anyone with the link), 404 if unknown
//   POST /chat/rooms         create a room (signed-in poietic users only)
//   GET  /chat/config?room=  ICE servers incl. TURN, only for existing rooms
//   GET  /chat/ws?room=      WebSocket to the room's Durable Object
//   everything else          static assets from public/

import { authenticate } from "./auth";
import { cloudflareTurn, STUN_ONLY, type IceServer } from "./turn";
import type { Room } from "./room";

export { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
  DEV_AUTH_BYPASS?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_PATH = /^\/chat\/r\/([^/]+)\/?$/;

// Per-isolate, so credentials are shared across requests the isolate serves.
let getIceServers: (() => Promise<IceServer[]>) | null = null;

function iceServersFor(env: Env): Promise<IceServer[]> {
  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_KEY_API_TOKEN) return Promise.resolve(STUN_ONLY);
  getIceServers ??= cloudflareTurn({
    keyId: env.CF_TURN_KEY_ID,
    apiToken: env.CF_TURN_KEY_API_TOKEN,
    fallback: STUN_ONLY,
  });
  return getIceServers();
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

function roomStub(env: Env, id: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

async function roomExists(env: Env, id: string | null): Promise<boolean> {
  return !!id && UUID.test(id) && (await roomStub(env, id).exists());
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  // Cookies ride along on cross-site POSTs; only accept our own pages' requests.
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return json({ error: "forbidden" }, 403);
  }
  const caller = await authenticate(request, env);
  if (!caller) return json({ error: "signin" }, 401);

  const id = crypto.randomUUID();
  await roomStub(env, id).init(caller.sub);
  return json({ id, url: `/chat/r/${id}` }, 201);
}

async function roomPage(request: Request, env: Env, id: string): Promise<Response> {
  const page = new URL("/chat/room", request.url);
  if (await roomExists(env, id)) return env.ASSETS.fetch(new Request(page, request));
  const missing = new URL("/chat/missing", request.url);
  const res = await env.ASSETS.fetch(new Request(missing, request));
  return new Response(res.body, { status: 404, headers: res.headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");

    if (url.pathname === "/chat/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    if (url.pathname === "/chat/config") {
      if (!(await roomExists(env, room))) return json({ error: "not-found" }, 404);
      return json({ iceServers: await iceServersFor(env) });
    }

    if (url.pathname === "/chat/ws") {
      if (!room || !UUID.test(room)) return new Response("Bad room", { status: 400 });
      return roomStub(env, room).fetch(request);
    }

    const match = url.pathname.match(ROOM_PATH);
    if (match) return roomPage(request, env, match[1]!);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
