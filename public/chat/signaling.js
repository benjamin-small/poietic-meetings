// WebSocket to the room's Durable Object (protocol: src/room.ts), kept alive
// with a heartbeat and reconnected automatically when it drops. Video keeps
// flowing peer to peer meanwhile; only new signaling waits.

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}'; // answered by the runtime, not the room code
const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 45_000; // no pong this long = the connection is dead even if nobody said so
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
const GIVE_UP_AFTER_MS = 120_000;

/**
 * @param roomId
 * @param handlers
 *   onOpen()              connected (again): send `join` now
 *   onMessage(msg)        any server message except pong
 *   onDrop({code, wasClean, online, visible})   connection lost; reconnecting
 *   onGiveUp({downMs, attempts})                stopped trying
 */
export function openSignaling(roomId, { onOpen, onMessage, onDrop, onGiveUp }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/chat/ws?room=${roomId}`;
  let ws;
  let lastPong = 0;
  let attempts = 0;
  let droppedAt = 0;
  let retryTimer = 0;
  let stopped = false;

  function connect() {
    clearTimeout(retryTimer);
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    // Events from a socket we've already moved on from are ignored.
    sock.onopen = () => {
      if (sock !== ws) return;
      lastPong = Date.now();
      onOpen();
    };
    sock.onmessage = (e) => {
      if (sock !== ws) return;
      if (e.data === PONG) {
        lastPong = Date.now();
        return;
      }
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "full" || msg.type === "not-found") stopped = true;
      onMessage(msg);
    };
    sock.onclose = (e) => {
      if (sock !== ws || stopped) return;
      handleDrop(e.code, e.wasClean);
    };
  }

  function handleDrop(code, wasClean) {
    if (!droppedAt) {
      droppedAt = Date.now();
      onDrop({ code, wasClean, online: navigator.onLine, visible: document.visibilityState === "visible" });
    }
    scheduleRetry();
  }

  function scheduleRetry() {
    if (Date.now() - droppedAt > GIVE_UP_AFTER_MS) {
      stopped = true;
      onGiveUp({ downMs: Date.now() - droppedAt, attempts });
      return;
    }
    const base = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    attempts++;
    retryTimer = setTimeout(connect, base + Math.random() * base * 0.3);
  }

  /** Reconnect right away (e.g. the network came back) instead of waiting out the backoff. */
  function nudge() {
    if (!stopped && droppedAt && ws?.readyState !== WebSocket.OPEN && ws?.readyState !== WebSocket.CONNECTING) connect();
  }

  const heartbeat = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > DEAD_AFTER_MS) {
      // A dead connection can't finish a close handshake, so don't wait for
      // one: abandon the socket (its events are now ignored) and reconnect.
      const dead = ws;
      ws = undefined;
      try {
        dead.close(4000, "no pong");
      } catch {}
      handleDrop(4000, false);
      return;
    }
    ws.send(PING);
  }, PING_EVERY_MS);

  addEventListener("online", nudge);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && nudge());

  connect();

  return {
    send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    /** Call once the server has welcomed us back; returns how the outage went. */
    recovered() {
      const outage = droppedAt ? { downMs: Date.now() - droppedAt, attempts } : null;
      droppedAt = 0;
      attempts = 0;
      return outage;
    },
    /** Deliberate leave: tell the room so it skips the grace period. */
    close() {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "leave" }));
      ws?.close(1000, "leave");
    },
  };
}
