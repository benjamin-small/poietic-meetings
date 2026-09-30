// One Durable Object per chat room. It exists only once `init` has run
// (i.e. a signed-in user created it), holds up to MAX_PEERS WebSockets, and
// relays signaling between them. Media and chat never pass through here.
//
// Protocol (JSON over the WebSocket):
//   client → server  join {name}                      first message after connecting
//   server → client  welcome {id, peers:[{id,name}]}  your id + who's already here
//   server → others  peer-joined {id, name}
//   client → server  offer|answer|candidate {to, …}   relayed to `to` only,
//   server → target  … plus {from}                    with `from` set by the server
//   server → all     peer-left {id}
//   server → client  full | not-found                 then the socket closes
//
// The newcomer offers to everyone already present; existing peers only
// answer. That ordering means two offers can never cross.

import { DurableObject } from "cloudflare:workers";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // delete after this long with nobody connected
export const MAX_PEERS = 6; // mesh: each person uploads to every other, so keep it small
const NAME_MAX = 32;
const MESSAGE_MAX = 64 * 1024; // SDP with many candidates is a few KB
const RELAYED = new Set(["offer", "answer", "candidate"]);

interface RoomMeta {
  creator: string;
  createdAt: number;
}

/** Stored on each WebSocket so it survives hibernation. name is null until `join`. */
interface Peer {
  id: string;
  name: string | null;
}

export function cleanName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name || "Guest";
}

export class Room extends DurableObject {
  async init(creator: string): Promise<void> {
    const meta: RoomMeta = { creator, createdAt: Date.now() };
    await this.ctx.storage.put("meta", meta);
    // Unused rooms expire too, not just abandoned ones.
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async exists(): Promise<boolean> {
    return (await this.ctx.storage.get<RoomMeta>("meta")) !== undefined;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();

    const reject = (type: "not-found" | "full") => {
      server.accept();
      server.send(JSON.stringify({ type }));
      server.close(1000, type);
      return new Response(null, { status: 101, webSocket: client });
    };

    if (!(await this.exists())) return reject("not-found");
    if (this.openSockets().length >= MAX_PEERS) return reject("full");

    this.ctx.acceptWebSocket(server);
    const peer: Peer = { id: crypto.randomUUID().slice(0, 8), name: null };
    server.serializeAttachment(peer);
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > MESSAGE_MAX) return;
    let msg: { type?: unknown; to?: unknown; name?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const me = peerOf(ws);

    if (msg.type === "join") {
      if (me.name !== null) return; // join once
      me.name = cleanName(msg.name);
      ws.serializeAttachment(me);
      const others = this.joined().filter((p) => p.ws !== ws);
      send(ws, { type: "welcome", id: me.id, peers: others.map(({ id, name }) => ({ id, name })) });
      for (const p of others) send(p.ws, { type: "peer-joined", id: me.id, name: me.name });
      return;
    }

    if (typeof msg.type !== "string" || !RELAYED.has(msg.type) || me.name === null) return;
    const target = this.joined().find((p) => p.id === msg.to && p.ws !== ws);
    // `from` is always ours, overwriting anything the sender claimed.
    if (target) send(target.ws, { ...msg, from: me.id });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.leave(ws);
  }

  async alarm(): Promise<void> {
    if (this.openSockets().length === 0) await this.ctx.storage.deleteAll();
  }

  private async leave(ws: WebSocket): Promise<void> {
    const me = peerOf(ws);
    if (me.name !== null) {
      for (const p of this.joined()) if (p.ws !== ws) send(p.ws, { type: "peer-left", id: me.id });
    }
    if (this.openSockets().filter((s) => s !== ws).length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  /** Open sockets that have sent `join`, with their peer info. */
  private joined(): { ws: WebSocket; id: string; name: string }[] {
    const out = [];
    for (const ws of this.openSockets()) {
      const { id, name } = peerOf(ws);
      if (name !== null) out.push({ ws, id, name });
    }
    return out;
  }
}

function peerOf(ws: WebSocket): Peer {
  return ws.deserializeAttachment() as Peer;
}

function send(ws: WebSocket, msg: object): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed between the readyState check and the send.
  }
}
