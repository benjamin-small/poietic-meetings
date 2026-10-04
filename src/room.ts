// One Durable Object per chat room. It exists only once `init` has run
// (i.e. a signed-in user created it), holds up to MAX_PEERS people, and
// relays signaling between them. Media and chat never pass through here.
//
// Protocol (JSON over the WebSocket):
//   client → server  join {name, resume?: {id, token}}  first message after connecting
//   server → client  welcome {id, token, resumed, peers:[{id,name}], iceServers}
//   server → others  peer-joined {id, name}             (not sent for a resume)
//   server → others  peer-resumed {id}                  someone came back after a drop;
//                                                        unfinished calls with them restart
//   client → server  offer|answer|candidate {to, …}     relayed to `to` only,
//   server → target  … plus {from}                      with `from` set by the server
//   client → server  leave                              deliberate exit
//   client → server  leave {resume: {id, token}}        same, from a socket that
//                                                        never joined (leaving mid-reconnect)
//   server → all     peer-left {id}
//   server → client  full | not-found                   then the socket closes
//   client → server  {"type":"ping"}  →  {"type":"pong"}  answered by the runtime
//                                                        without waking this object
//
// ICE servers (including TURN credentials) are only handed out in welcome,
// so only people in the room get them.
//
// The newcomer offers to everyone already present. Offers can still cross
// (a resumed peer offering to someone who joined while it was away, or both
// sides retrying a failed connection); the client settles that with
// polite/impolite roles (public/chat/mesh.js).
//
// Connections drop without warning (mobile networks, Cloudflare restarting
// servers, this object being reset). So people are tracked in storage, not
// by their sockets: a dropped socket starts a GRACE_MS window in which the
// same browser can rejoin with its {id, token} and nobody else notices.
// After the window, everyone gets peer-left. A deliberate leave (the
// `leave` message, or close code 1000/1001) skips the grace period.

import { DurableObject } from "cloudflare:workers";
import { cloudflareTurn, STUN_ONLY, type IceServer } from "./turn";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // delete after this long with nobody present
export const MAX_PEERS = 6; // mesh: each person uploads to every other, so keep it small
export const MAX_SOCKETS = MAX_PEERS * 2; // headroom for people whose old socket lingers
export const GRACE_MS = 30_000; // how long a dropped person can come back silently
export const STALE_MS = 60_000; // no ping for this long = dead connection (clients ping every 20s)
export const JOIN_DEADLINE_MS = 10_000; // clients join right after connecting; idlers are closed
export const SWEEP_MS = 15_000; // how often to check for the above while anyone is here
const NAME_MAX = 32;
const MESSAGE_MAX = 64 * 1024; // SDP with many candidates is a few KB
const RELAYED = new Set(["offer", "answer", "candidate"]);
const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

interface RoomMeta {
  creator: string;
  createdAt: number;
}

/** A person in the room. Survives dropped sockets and object resets. */
interface Person {
  id: string;
  token: string;
  name: string;
  /** Which connection currently speaks for this person. */
  conn: string;
  /** Set while they have no live socket; cleared when they rejoin. */
  goneSince?: number;
}

/** Stored on each WebSocket so it survives hibernation. */
interface Attachment {
  conn: string;
  room: string;
  connectedAt: number;
  /** Set once `join` succeeds. */
  id?: string;
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name || "Guest";
}

/** One structured line per event, searchable in Workers Logs. No names. */
function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

const randomId = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

interface TurnEnv {
  CF_TURN_KEY_ID?: string;
  CF_TURN_KEY_API_TOKEN?: string;
}

export class Room extends DurableObject {
  private readonly turnEnv: TurnEnv;
  // Per room, so credentials are shared only by people in this room.
  private getIceServers: (() => Promise<IceServer[]>) | null = null;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.turnEnv = env as TurnEnv;
    // Heartbeats are answered by the runtime itself, so they don't wake the
    // object; getWebSocketAutoResponseTimestamp tells us when each last pinged.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  private iceServers(): Promise<IceServer[]> {
    const { CF_TURN_KEY_ID, CF_TURN_KEY_API_TOKEN } = this.turnEnv;
    if (!CF_TURN_KEY_ID || !CF_TURN_KEY_API_TOKEN) return Promise.resolve(STUN_ONLY);
    this.getIceServers ??= cloudflareTurn({ keyId: CF_TURN_KEY_ID, apiToken: CF_TURN_KEY_API_TOKEN, fallback: STUN_ONLY });
    return this.getIceServers();
  }

  async init(creator: string): Promise<void> {
    const meta: RoomMeta = { creator, createdAt: Date.now() };
    await this.ctx.storage.put("meta", meta);
    await this.schedule(); // unused rooms expire too
  }

  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<RoomMeta>("meta")) !== undefined;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const room = (new URL(request.url).searchParams.get("room") ?? "").slice(0, 8);
    const { 0: client, 1: server } = new WebSocketPair();

    const reject = (type: "not-found" | "full") => {
      log("reject", { room, why: type });
      server.accept();
      server.send(JSON.stringify({ type }));
      server.close(1000, type);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!(await this.exists())) return reject("not-found");
    // The real cap is on people, checked at join. This one only bounds
    // sockets: at the limit, make room by closing the longest-waiting socket
    // that never joined, so idle sockets can't lock anyone out (including
    // members coming back to resume).
    const open = this.openSockets();
    if (open.length >= MAX_SOCKETS) {
      const idle = open
        .filter((ws) => !attachmentOf(ws).id)
        .sort((a, b) => attachmentOf(a).connectedAt - attachmentOf(b).connectedAt)[0];
      if (!idle) return reject("full");
      log("evict", { room, conn: attachmentOf(idle).conn });
      try {
        idle.close(4003, "evicted");
      } catch {}
    }

    this.ctx.acceptWebSocket(server);
    const attachment: Attachment = { conn: randomId(6), room, connectedAt: Date.now() };
    server.serializeAttachment(attachment);
    log("connect", { room, conn: attachment.conn, sockets: this.openSockets().length });
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > MESSAGE_MAX) return;
    let msg: { type?: unknown; to?: unknown; name?: unknown; resume?: { id?: unknown; token?: unknown } };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const att = attachmentOf(ws);

    if (msg.type === "join") return this.join(ws, att, msg);
    if (msg.type === "leave" && !att.id) return this.farewell(ws, att, msg);
    if (!att.id) return;
    const me = await this.person(att.id);
    if (!me || me.conn !== att.conn) return; // superseded by a newer connection

    if (msg.type === "leave") {
      log("leave", { room: att.room, peer: me.id, how: "message" });
      await this.remove(me);
      ws.close(1000, "left");
      return;
    }

    if (typeof msg.type !== "string" || !RELAYED.has(msg.type)) return;
    const target = this.socketFor(await this.person(String(msg.to)));
    // `from` is always ours, overwriting anything the sender claimed.
    if (target && target !== ws) send(target, { ...msg, from: me.id });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Finish the close handshake. Without this reply the browser waits ~10s
    // and then reports an unclean 1006, which also delays reconnecting.
    // 1005/1006 are reserved and can't be sent, so answer those with 1000.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    await this.dropped(ws, code === 1000 || code === 1001 ? "closed" : "dropped", { code, wasClean });
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropped(ws, "dropped", { code: "error" });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    // Read before the sweep: letting the last person go below re-arms the
    // 24h TTL (marker "expire"), and that must not count as the TTL running out.
    const expiring = (await this.ctx.storage.get<string>("alarm")) === "expire";

    // Sockets that stopped pinging are dead even if nobody told us, and
    // sockets that never joined have no business staying open.
    for (const ws of this.openSockets()) {
      const att = attachmentOf(ws);
      if (!att.id && now - att.connectedAt > JOIN_DEADLINE_MS) {
        log("unjoined", { room: att.room, conn: att.conn });
        try {
          ws.close(4003, "join timeout");
        } catch {}
        continue;
      }
      const lastSeen = Math.max(att.connectedAt, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0);
      if (now - lastSeen > STALE_MS) {
        log("stale", { room: att.room, peer: att.id, conn: att.conn, silentMs: now - lastSeen });
        try {
          ws.close(4001, "stale");
        } catch {}
        await this.dropped(ws, "dropped", { code: 4001 });
      }
    }

    // People without a live connection: start their grace period (this
    // covers an object reset, where sockets vanish without close events),
    // and let them go once it runs out.
    for (const p of await this.people()) {
      if (this.socketFor(p)) continue;
      if (p.goneSince === undefined) {
        p.goneSince = now;
        await this.save(p);
        log("missing", { peer: p.id });
      } else if (now - p.goneSince >= GRACE_MS) {
        log("leave", { peer: p.id, how: "grace-expired", goneMs: now - p.goneSince });
        await this.remove(p);
      }
    }

    const empty = (await this.people()).length === 0 && this.openSockets().length === 0;
    if (empty && expiring) {
      log("expire", {});
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.schedule();
  }

  private async join(ws: WebSocket, att: Attachment, msg: { name?: unknown; resume?: { id?: unknown; token?: unknown } }) {
    if (att.id) return; // join once per connection
    const people = await this.people();
    const claimed = people.find((p) => p.id === msg.resume?.id && p.token === msg.resume?.token);

    if (claimed) {
      const old = this.socketFor(claimed);
      claimed.conn = att.conn;
      delete claimed.goneSince;
      await this.save(claimed);
      att.id = claimed.id;
      ws.serializeAttachment(att);
      if (old && old !== ws) {
        try {
          old.close(4002, "replaced");
        } catch {}
      }
      // Signaling to or from them may have been lost while they were away.
      for (const p of people) {
        const s = p.id === claimed.id ? undefined : this.socketFor(p);
        if (s) send(s, { type: "peer-resumed", id: claimed.id });
      }
      log("join", { room: att.room, peer: claimed.id, resumed: true, people: people.length });
      await this.schedule();
      // Fetched last: it may go out to the network, and everything above is
      // already saved, so another event interleaving here sees a consistent room.
      const iceServers = await this.iceServers();
      send(ws, { type: "welcome", id: claimed.id, token: claimed.token, resumed: true, peers: others(people, claimed.id), iceServers });
      return;
    }

    if (people.length >= MAX_PEERS) {
      log("reject", { room: att.room, why: "full", people: people.length });
      send(ws, { type: "full" });
      ws.close(1000, "full");
      return;
    }
    const me: Person = { id: randomId(4), token: randomId(16), name: cleanName(msg.name), conn: att.conn };
    await this.save(me);
    att.id = me.id;
    ws.serializeAttachment(att);
    log("join", { room: att.room, peer: me.id, resumed: false, people: people.length + 1 });
    for (const p of people) {
      const s = this.socketFor(p);
      if (s) send(s, { type: "peer-joined", id: me.id, name: me.name });
    }
    await this.schedule();
    const iceServers = await this.iceServers(); // last, as above
    send(ws, { type: "welcome", id: me.id, token: me.token, resumed: false, peers: others(people, me.id), iceServers });
  }

  /** A `leave` from a socket that never joined: a browser leaving while its connection was down. */
  private async farewell(ws: WebSocket, att: Attachment, msg: { resume?: { id?: unknown; token?: unknown } }) {
    const p = (await this.people()).find((p) => p.id === msg.resume?.id && p.token === msg.resume?.token);
    if (p) {
      log("leave", { room: att.room, peer: p.id, how: "farewell" });
      await this.remove(p);
    }
    ws.close(1000, "left");
  }

  /** A socket went away. Deliberate → leave now; otherwise start the grace period. */
  private async dropped(ws: WebSocket, how: "closed" | "dropped", fields: Record<string, unknown>) {
    const att = attachmentOf(ws);
    log("close", { room: att.room, peer: att.id, conn: att.conn, how, ...fields });
    if (att.id) {
      const me = await this.person(att.id);
      if (me && me.conn === att.conn) {
        if (how === "closed") {
          log("leave", { room: att.room, peer: me.id, how: "closed" });
          await this.remove(me);
        } else if (me.goneSince === undefined) {
          me.goneSince = Date.now();
          await this.save(me);
        }
      }
    }
    await this.schedule();
  }

  private async remove(p: Person) {
    await this.ctx.storage.delete(`person:${p.id}`);
    for (const other of await this.people()) {
      const s = this.socketFor(other);
      if (s) send(s, { type: "peer-left", id: p.id });
    }
    await this.schedule();
  }

  /** Sweep often while anyone is around; otherwise wait out the room's TTL. */
  private async schedule() {
    const busy = (await this.people()).length > 0 || this.openSockets().length > 0;
    await this.ctx.storage.put("alarm", busy ? "sweep" : "expire");
    if (!busy) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    // Only ever move a pending sweep earlier. Re-arming it on every event
    // would let a steady stream of events postpone it forever.
    const now = Date.now();
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending <= now || pending > now + SWEEP_MS) {
      await this.ctx.storage.setAlarm(now + SWEEP_MS);
    }
  }

  private async people(): Promise<Person[]> {
    return [...(await this.ctx.storage.list<Person>({ prefix: "person:" })).values()];
  }

  private async person(id: string): Promise<Person | undefined> {
    return this.ctx.storage.get<Person>(`person:${id}`);
  }

  private async save(p: Person) {
    await this.ctx.storage.put(`person:${p.id}`, p);
  }

  /** The live socket currently speaking for this person, if any. */
  private socketFor(p: Person | undefined): WebSocket | undefined {
    if (!p) return undefined;
    return this.openSockets().find((ws) => attachmentOf(ws).conn === p.conn);
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
}

function others(people: Person[], id: string) {
  return people.filter((p) => p.id !== id).map(({ id, name }) => ({ id, name }));
}

function attachmentOf(ws: WebSocket): Attachment {
  return ws.deserializeAttachment() as Attachment;
}

function send(ws: WebSocket, msg: object): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed between the readyState check and the send.
  }
}
