// WebSocket to the room's Durable Object. Protocol: see src/room.ts.

export function openSignaling(roomId, { onOpen, onMessage, onClose }) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/chat/ws?room=${roomId}`);
  ws.onopen = () => onOpen();
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  ws.onclose = () => onClose();
  return {
    send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
