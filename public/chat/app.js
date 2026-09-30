import { openSignaling } from "/chat/signaling.js";
import { MeshCall } from "/chat/mesh.js";

const MAX_PEOPLE = 6; // matches MAX_PEERS in src/room.ts
const NAME_KEY = "tinker-chat-name";

const $ = (id) => document.getElementById(id);
const grid = $("grid");
const statusEl = $("status");
const messages = $("messages");
const chatForm = $("chat-form");
const chatInput = $("chat-input");
const chatButton = chatForm.querySelector("button");

const roomId = location.pathname.split("/").pop();
if (!/^[0-9a-f-]{36}$/.test(roomId)) location.replace("/chat");
// Add ?relay=1 to force all media through TURN (for testing TURN setup).
const forceRelay = new URLSearchParams(location.search).has("relay");

const names = new Map(); // peer id -> name
const tiles = new Map(); // peer id ("self" for us) -> tile element
let signaling;
let call;
let localStream;
let ended = false;
let me = null; // { id, token } from the server's welcome; used to resume after a drop
let joinedAt = 0;
let reconnecting = false;
let lastDrop = null; // details of the latest drop, resent on reconnect in case the first report was lost

/** Tell the server something went wrong, for Workers Logs. Best effort. */
function report(event, fields = {}) {
  const body = JSON.stringify({ event, room: roomId, peer: me?.id, peers: names.size, ...fields });
  fetch("/chat/report", { method: "POST", body, keepalive: true }).catch(() => {});
}

const setStatus = (text) => (statusEl.textContent = text);

function addMessage(text, { from, cls } = {}) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  if (from) {
    const who = document.createElement("strong");
    who.textContent = from;
    li.append(who, " ");
  }
  li.append(text);
  messages.append(li);
  messages.scrollTop = messages.scrollHeight;
}

// --- Video tiles ---
function initials(name) {
  return name.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
}

function addTile(id, name) {
  const tile = $("tile-template").content.firstElementChild.cloneNode(true);
  tile.dataset.id = id;
  tile.querySelector(".name").textContent = id === "self" ? `${name} (you)` : name;
  tile.querySelector(".avatar").textContent = initials(name);
  if (id === "self") {
    tile.classList.add("self");
    tile.querySelector("video").muted = true;
  }
  tiles.set(id, tile);
  grid.append(tile);
  updateLayout();
  return tile;
}

function removeTile(id) {
  tiles.get(id)?.remove();
  tiles.delete(id);
  updateLayout();
}

function setTileState(id, state) {
  const label = { connecting: "Connecting…", failed: "Couldn't connect", connected: "" }[state] ?? "";
  const tile = tiles.get(id);
  if (!tile) return;
  tile.querySelector(".state").textContent = label;
  tile.classList.toggle("failed", state === "failed");
}

function setTileMedia(id, { mic, cam }) {
  const tile = tiles.get(id);
  if (!tile) return;
  tile.querySelector(".muted").hidden = mic;
  tile.classList.toggle("cam-off", !cam);
}

function updateLayout() {
  grid.dataset.count = String(tiles.size);
  const others = tiles.size - (tiles.has("self") ? 1 : 0);
  $("count").textContent = `${tiles.size} of ${MAX_PEOPLE}`;
  if (!ended && !reconnecting && call) setStatus(others === 0 ? "Waiting for others… Share the link!" : "");
}

function setChatEnabled(open) {
  chatInput.disabled = chatButton.disabled = open === 0;
  chatInput.placeholder = open === 0 ? "Waiting for others…" : "Say something…";
}

function end(text) {
  ended = true;
  setStatus(text);
}

// --- Join flow ---
function defaultName() {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved) return saved;
  } catch {}
  return `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
}

function askName() {
  const dialog = $("join-dialog");
  const input = $("name-input");
  input.value = defaultName();
  return new Promise((resolve) => {
    $("join-form").onsubmit = () => {
      const name = input.value.trim().slice(0, 32) || "Guest";
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {}
      resolve(name);
    };
    dialog.addEventListener("cancel", (e) => e.preventDefault()); // must pick a name
    dialog.showModal();
    input.select();
  });
}

function wireCall() {
  call.addEventListener("peer-joined", ({ detail: { id, name } }) => {
    names.set(id, name);
    addTile(id, name);
    addMessage(`${name} joined`, { cls: "sys" });
  });
  call.addEventListener("peer-left", ({ detail: { id } }) => {
    if (names.has(id)) addMessage(`${names.get(id)} left`, { cls: "sys" });
    names.delete(id);
    removeTile(id);
  });
  call.addEventListener("stream", ({ detail: { id, stream } }) => {
    const video = tiles.get(id)?.querySelector("video");
    if (video && video.srcObject !== stream) video.srcObject = stream;
  });
  call.addEventListener("state", ({ detail: { id, state, diag } }) => {
    setTileState(id, state);
    if (state === "failed") report("peer-failed", { remote: id, ...diag });
  });
  call.addEventListener("media", ({ detail: { id, mic, cam } }) => setTileMedia(id, { mic, cam }));
  call.addEventListener("chat", ({ detail: { id, text } }) => addMessage(text, { from: names.get(id) ?? "?" }));
  call.addEventListener("channels", ({ detail: { open } }) => setChatEnabled(open));
}

async function start() {
  const name = await askName();
  setStatus("Starting camera…");
  let iceServers;
  try {
    ({ iceServers } = await (await fetch(`/chat/config?room=${roomId}`)).json());
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      audio: true,
    });
  } catch (err) {
    console.error(err);
    return end(`Couldn't access camera/microphone: ${err.message}`);
  }

  addTile("self", name).querySelector("video").srcObject = localStream;

  call = new MeshCall({ iceServers, forceRelay, sendSignal: (msg) => signaling.send(msg) });
  call.start(localStream);
  wireCall();

  signaling = openSignaling(roomId, {
    onOpen: () => {
      if (!reconnecting) setStatus("Joining…");
      signaling.send({ type: "join", name, resume: me ?? undefined });
    },
    onMessage: (msg) => {
      if (msg.type === "full") return end(`This room is full (${MAX_PEOPLE} people max).`);
      if (msg.type === "not-found") return end("This room doesn't exist or has expired.");
      if (msg.type === "welcome") {
        me = { id: msg.id, token: msg.token };
        joinedAt ||= Date.now();
        const outage = signaling.recovered();
        if (outage) report("reconnected", { ...lastDrop, ...outage, resumed: msg.resumed });
        lastDrop = null;
        reconnecting = false;
        updateLayout();
      }
      call.handleSignal(msg);
    },
    onDrop: ({ code, wasClean, online, visible }) => {
      reconnecting = true;
      setStatus("Reconnecting to the room… (video continues)");
      lastDrop = { code, wasClean, online, visible, inCallMs: joinedAt ? Date.now() - joinedAt : 0 };
      report("ws-close", lastDrop); // may not arrive if the server is what went away
    },
    onGiveUp: ({ downMs, attempts }) => {
      report("gave-up", { ...lastDrop, downMs, attempts });
      end("Lost the connection to the room. Reload to rejoin.");
    },
  });
}

// --- Controls ---
function toggle(button, kind, onLabel, offLabel) {
  const tracks = localStream?.getTracks().filter((t) => t.kind === kind) ?? [];
  const enabled = !tracks[0]?.enabled;
  tracks.forEach((t) => (t.enabled = enabled));
  button.textContent = enabled ? onLabel : offLabel;
  button.classList.toggle("off", !enabled);
  const media = {
    mic: localStream?.getAudioTracks()[0]?.enabled ?? false,
    cam: localStream?.getVideoTracks()[0]?.enabled ?? false,
  };
  setTileMedia("self", media);
  call?.setMediaState(media);
}
$("mic").onclick = (e) => toggle(e.currentTarget, "audio", "Mic on", "Mic off");
$("cam").onclick = (e) => toggle(e.currentTarget, "video", "Cam on", "Cam off");
$("copy").onclick = async (e) => {
  await navigator.clipboard.writeText(location.origin + location.pathname);
  e.currentTarget.textContent = "Copied!";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
};
$("leave").onclick = () => {
  ended = true;
  call?.leave();
  signaling?.close();
  localStream?.getTracks().forEach((t) => t.stop());
  location.href = "/chat";
};

chatForm.onsubmit = (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !call) return;
  if (call.sendChat(text) > 0) {
    addMessage(text, { from: "You", cls: "me" });
    chatInput.value = "";
  }
};

start();
