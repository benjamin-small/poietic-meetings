// One Durable Object per chat room. It exists only once `init` has run
// (i.e. a signed-in user created it), holds at most two WebSockets, and
// relays signaling between them. Media and chat never pass through here.

import { DurableObject } from "cloudflare:workers";

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // delete after this long with nobody connected
const MAX_PEERS = 2;
const RELAYED = new Set(["offer", "answer", "candidate"]);

interface RoomMeta {
  creator: string;
  createdAt: number;
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
    const peers = this.openSockets();
    if (peers.length >= MAX_PEERS) return reject("full");

    this.ctx.acceptWebSocket(server);
    await this.ctx.storage.deleteAlarm();
    // Second arrival: tell the one already waiting to make the offer.
    for (const p of peers) send(p, { type: "peer-joined" });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") return;
    let msg: { type?: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.type !== "string" || !RELAYED.has(msg.type)) return;
    for (const p of this.openSockets()) if (p !== ws) p.send(data);
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
    const others = this.openSockets().filter((p) => p !== ws);
    for (const p of others) send(p, { type: "peer-left" });
    if (others.length === 0) await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }
}

function send(ws: WebSocket, msg: object): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Socket closed between the readyState check and the send.
  }
}
