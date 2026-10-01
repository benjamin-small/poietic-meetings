// WebSocket to the room's Durable Object (protocol: src/room.ts), kept alive
// with a heartbeat and reconnected automatically when it drops. Video keeps
// flowing peer to peer meanwhile; only new signaling waits.

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}'; // answered by the runtime, not the room code
const PING_EVERY_MS = 20_000;
const DEAD_AFTER_MS = 45_000; // no pong this long = the connection is dead even if nobody said so
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];
// Counted in attempts, not wall-clock time, so a page that was suspended
// (phone locked, laptop asleep) still gets its tries when it wakes up.
const MAX_ATTEMPTS = 12; // about two minutes of retrying
const CONNECT_TIMEOUT_MS = 10_000; // browsers can sit in CONNECTING for minutes
const FAREWELL_TIMEOUT_MS = 2000;

/**
 * @param roomId
 * @param handlers
 *   onOpen()              connected (again): send `join` now
 *   onMessage(msg)        any server message except pong
 *   onDrop({code, wasClean, online, visible})   connection lost; reconnecting
 *   onGiveUp({downMs, attempts})                stopped trying
 * Returns {send(msg), recovered(), close(resume?)}.
 */
export function openSignaling(roomId, { onOpen, onMessage, onDrop, onGiveUp }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/chat/ws?room=${roomId}`;
  let ws;
  let lastPong = 0;
  let attempts = 0;
  let droppedAt = 0;
  let retryTimer = 0;
  let connectTimer = 0;
  let stopped = false;

  function connect() {
    clearTimeout(retryTimer);
    clearTimeout(connectTimer);
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    connectTimer = setTimeout(() => {
      if (sock === ws && sock.readyState === WebSocket.CONNECTING) abandon("connect timeout");
    }, CONNECT_TIMEOUT_MS);
    // Events from a socket we've already moved on from are ignored.
    sock.onopen = () => {
      if (sock !== ws) return;
      clearTimeout(connectTimer);
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
      // "full" only ends things before we've ever joined; while reconnecting
      // it's temporary (the server closes the socket and we try again).
      if (msg.type === "not-found" || (msg.type === "full" && !droppedAt)) stopped = true;
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

  /** Give up on the current socket without waiting for a close handshake it may never finish. */
  function abandon(reason) {
    const dead = ws;
    ws = undefined; // its events are now ignored
    try {
      dead?.close(4000, reason);
    } catch {}
    handleDrop(4000, false);
  }

  function scheduleRetry() {
    if (attempts >= MAX_ATTEMPTS) {
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
    if (stopped || !droppedAt || ws?.readyState === WebSocket.OPEN) return;
    // A connect stuck since before the network changed won't recover; start a fresh one.
    if (ws) {
      const stalled = ws;
      ws = undefined;
      try {
        stalled.close(4000, "network changed");
      } catch {}
    }
    connect();
  }

  const heartbeat = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastPong > DEAD_AFTER_MS) {
      abandon("no pong");
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
    /**
     * Deliberate leave: tell the room so it skips the grace period. `resume`
     * ({id, token} from welcome) lets us say goodbye even if our connection
     * is down right now. Resolves once the goodbye is out (or given up on).
     */
    close(resume) {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(retryTimer);
      clearTimeout(connectTimer);
      const current = ws;
      ws = undefined;
      const leave = JSON.stringify({ type: "leave", resume });
      if (current?.readyState === WebSocket.OPEN) {
        current.send(leave);
        current.close(1000, "leave");
        return Promise.resolve();
      }
      try {
        current?.close(1000, "leave");
      } catch {}
      if (!resume) return Promise.resolve();
      // Not connected: open a socket just to say goodbye.
      return new Promise((resolve) => {
        const bye = new WebSocket(url);
        const timer = setTimeout(() => {
          try {
            bye.close();
          } catch {}
          resolve();
        }, FAREWELL_TIMEOUT_MS);
        bye.onopen = () => bye.send(leave);
        bye.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}
