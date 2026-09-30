const $ = (id) => document.getElementById(id);
const remoteVideo = $("remote");
const localVideo = $("local");
const statusEl = $("status");
const messages = $("messages");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const chatButton = chatForm.querySelector("button");

const roomId = location.pathname.split("/").pop();
if (!/^[0-9a-f-]{36}$/.test(roomId)) location.replace("/chat");
// Add ?relay=1 to force all media through TURN (for testing TURN setup).
const forceRelay = new URLSearchParams(location.search).has("relay");
let iceServers = [];
let localStream;
let ws;
let pc;
let channel;
let pendingCandidates = [];
let connectTimer;

const setStatus = (text) => (statusEl.textContent = text);

function addMessage(text, cls = "") {
  const li = document.createElement("li");
  li.textContent = text;
  if (cls) li.className = cls;
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

function setChatEnabled(on) {
  chatInput.disabled = chatButton.disabled = !on;
  chatInput.placeholder = on ? "Say something…" : "Connect to chat…";
}

const CONNECT_TIMEOUT_MS = 15000;

function showConnectFailed() {
  setStatus(forceRelay ? "Relay connection failed. Check TURN config." : "Connection failed. A TURN server may be needed.");
}

// ICE can hang in "connecting" forever (e.g. no usable candidates) instead of failing.
function startConnecting() {
  setStatus("Connecting…");
  clearTimeout(connectTimer);
  connectTimer = setTimeout(showConnectFailed, CONNECT_TIMEOUT_MS);
}

const signal = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

function setupChannel(ch) {
  channel = ch;
  ch.onopen = () => setChatEnabled(true);
  ch.onclose = () => setChatEnabled(false);
  ch.onmessage = (e) => addMessage(String(e.data));
}

function newPeerConnection() {
  clearTimeout(connectTimer);
  pc?.close();
  channel = null;
  pendingCandidates = [];
  setChatEnabled(false);
  remoteVideo.srcObject = null;

  pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" });
  for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

  pc.onicecandidate = (e) => e.candidate && signal({ type: "candidate", candidate: e.candidate });
  pc.ontrack = (e) => (remoteVideo.srcObject = e.streams[0]);
  pc.ondatachannel = (e) => setupChannel(e.channel);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      clearTimeout(connectTimer);
      setStatus("");
    }
    if (pc.connectionState === "failed") {
      clearTimeout(connectTimer);
      showConnectFailed();
    }
  };
}

async function flushCandidates() {
  for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(console.warn);
  pendingCandidates = [];
}

async function handleSignal({ data }) {
  const msg = JSON.parse(data);
  switch (msg.type) {
    case "peer-joined": {
      // We were here first, so we make the offer.
      newPeerConnection();
      setupChannel(pc.createDataChannel("chat"));
      startConnecting();
      await pc.setLocalDescription(await pc.createOffer());
      signal({ type: "offer", sdp: pc.localDescription });
      break;
    }
    case "offer": {
      newPeerConnection();
      startConnecting();
      await pc.setRemoteDescription(msg.sdp);
      await flushCandidates();
      await pc.setLocalDescription(await pc.createAnswer());
      signal({ type: "answer", sdp: pc.localDescription });
      addMessage("Peer connected", "sys");
      break;
    }
    case "answer": {
      await pc.setRemoteDescription(msg.sdp);
      await flushCandidates();
      addMessage("Peer connected", "sys");
      break;
    }
    case "candidate": {
      if (pc?.remoteDescription) await pc.addIceCandidate(msg.candidate).catch(console.warn);
      else pendingCandidates.push(msg.candidate);
      break;
    }
    case "peer-left": {
      addMessage("Peer left", "sys");
      newPeerConnection();
      setStatus("Peer left. Waiting for someone to join…");
      break;
    }
    case "full": {
      setStatus("This room is full (2 people max).");
      break;
    }
    case "not-found": {
      setStatus("This room doesn't exist or has expired.");
      break;
    }
  }
}

function connectSignaling() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/chat/ws?room=${roomId}`);
  ws.onmessage = (e) => handleSignal(e).catch((err) => console.error("signal error", err));
  ws.onopen = () => setStatus("Waiting for someone to join… Share the link!");
  ws.onclose = () => {
    if (!/full|expired/.test(statusEl.textContent)) setStatus("Disconnected from server. Reload to retry.");
  };
}

// --- Controls ---
function toggle(button, kind, onLabel, offLabel) {
  const tracks = localStream?.getTracks().filter((t) => t.kind === kind) ?? [];
  const enabled = !tracks[0]?.enabled;
  tracks.forEach((t) => (t.enabled = enabled));
  button.textContent = enabled ? onLabel : offLabel;
  button.classList.toggle("off", !enabled);
}
$("mic").onclick = (e) => toggle(e.currentTarget, "audio", "Mic on", "Mic off");
$("cam").onclick = (e) => toggle(e.currentTarget, "video", "Cam on", "Cam off");
$("copy").onclick = async (e) => {
  await navigator.clipboard.writeText(location.origin + location.pathname);
  e.currentTarget.textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
};
$("leave").onclick = () => {
  ws?.close();
  pc?.close();
  localStream?.getTracks().forEach((t) => t.stop());
  location.href = "/chat";
};

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || channel?.readyState !== "open") return;
  channel.send(text);
  addMessage(text, "me");
  chatInput.value = "";
};

// --- Start ---
(async () => {
  try {
    ({ iceServers } = await (await fetch(`/chat/config?room=${roomId}`)).json());
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
    connectSignaling();
  } catch (err) {
    console.error(err);
    setStatus(`Couldn't access camera/microphone: ${err.message}`);
  }
})();
