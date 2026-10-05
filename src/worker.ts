// meetings.poietic.tech: group video chat over WebRTC, up to 6 people.
//
//   GET  /r/:uuid            room page (anyone with the link), 404 if unknown
//   POST /rooms              create a room (signed-in poietic users only)
//   GET  /ws?room=           WebSocket to the room's Durable Object (ICE/TURN
//                            servers arrive in its welcome, so only members get them)
//   POST /report             client diagnostics (dropped sockets, failed peers) → Workers Logs
//   everything else          static assets from public/ (the lobby is / itself)

import { authenticate } from "./auth";
import type { Room } from "./room";

export { Room } from "./room";

export interface Env {
  ASSETS: Fetcher;
  /** poietic-auth, for its JWKS. See wrangler.jsonc for why not plain fetch. */
  AUTH: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
  DEV_AUTH_BYPASS?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM_PATH = /^\/r\/([^/]+)\/?$/;

// What a browser may report, and nothing else. Values are clipped, so a
// report can't smuggle arbitrary text into the logs.
const REPORT_EVENTS = new Set(["ws-close", "reconnected", "gave-up", "peer-failed"]);
const REPORT_FIELDS: Record<string, "string" | "number" | "boolean"> = {
  room: "string",
  peer: "string",
  remote: "string",
  code: "number",
  wasClean: "boolean",
  inCallMs: "number",
  downMs: "number",
  attempts: "number",
  resumed: "boolean",
  online: "boolean",
  visible: "boolean",
  iceState: "string",
  connState: "string",
  localCandidates: "string",
  peers: "number",
};
const REPORT_MAX_BYTES = 2048;

async function report(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) return json({ error: "forbidden" }, 403);
  const text = await request.text();
  if (text.length > REPORT_MAX_BYTES) return json({ error: "too-large" }, 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad-json" }, 400);
  }
  if (typeof body.event !== "string" || !REPORT_EVENTS.has(body.event)) return json({ error: "bad-event" }, 400);
  const clean: Record<string, unknown> = { event: `client:${body.event}` };
  for (const [key, type] of Object.entries(REPORT_FIELDS)) {
    const v = body[key];
    if (typeof v !== type) continue;
    clean[key] = type === "string" ? String(v).slice(0, 64) : v;
  }
  if (typeof clean.room === "string") clean.room = clean.room.slice(0, 8);
  // Coarse client info from headers; enough to spot "Android Chrome" patterns.
  const ua = request.headers.get("user-agent") ?? "";
  clean.client = /Android/.test(ua) ? "android" : /iPhone|iPad/.test(ua) ? "ios" : /Mac OS X/.test(ua) ? "mac" : /Windows/.test(ua) ? "windows" : "other";
  clean.browser = /Edg\//.test(ua) ? "edge" : /Firefox\//.test(ua) ? "firefox" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : "other";
  const cf = (request as { cf?: { asOrganization?: string; httpProtocol?: string } }).cf;
  clean.network = cf?.asOrganization?.slice(0, 48);
  clean.protocol = cf?.httpProtocol;
  console.log(JSON.stringify(clean));
  return new Response(null, { status: 204 });
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
  let caller;
  try {
    caller = await authenticate(request, env, env.AUTH.fetch.bind(env.AUTH) as typeof fetch);
  } catch (err) {
    // The public keys couldn't be loaded at all. Fail closed, but say so.
    console.error("auth unavailable:", (err as Error).message);
    return json({ error: "auth-unavailable" }, 503);
  }
  if (!caller) return json({ error: "signin" }, 401);

  const id = crypto.randomUUID();
  await roomStub(env, id).init(caller.sub);
  return json({ id, url: `/r/${id}` }, 201);
}

async function roomPage(request: Request, env: Env, id: string): Promise<Response> {
  const page = new URL("/room", request.url);
  if (await roomExists(env, id)) return env.ASSETS.fetch(new Request(page, request));
  const missing = new URL("/missing", request.url);
  const res = await env.ASSETS.fetch(new Request(missing, request));
  return new Response(res.body, { status: 404, headers: res.headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room");

    if (url.pathname === "/rooms" && request.method === "POST") {
      return createRoom(request, env);
    }

    if (url.pathname === "/report" && request.method === "POST") {
      return report(request);
    }

    if (url.pathname === "/ws") {
      if (!room || !UUID.test(room)) return new Response("Bad room", { status: 400 });
      return roomStub(env, room).fetch(request);
    }

    const match = url.pathname.match(ROOM_PATH);
    if (match) return roomPage(request, env, match[1]!);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
