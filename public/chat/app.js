import { openSignaling } from "/chat/signaling.js";
import { MeshCall } from "/chat/mesh.js";

const MAX_PEOPLE = 6; // matches MAX_PEERS in src/room.ts
const NAME_KEY = "tinker-chat-name";
const MAX_MESSAGES = 200; // older chat lines are dropped, so a flood can't grow the page forever

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
  while (messages.childElementCount > MAX_MESSAGES) messages.firstElementChild.remove();
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
  // We're out of the room: stop the camera and mic, and drop any calls.
  call?.leave();
  localStream?.getTracks().forEach((t) => t.stop());
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
  const again = $("join-again");
  input.value = defaultName();
  return new Promise((resolve) => {
    let named = false;
    $("join-form").onsubmit = () => {
      named = true;
      const name = input.value.trim().slice(0, 32) || "Guest";
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {}
      resolve(name);
    };
    // Esc or Android back can close the dialog no matter what we do
    // (browsers ignore preventDefault without a user gesture), so don't
    // strand the page: offer a button to open it again.
    dialog.onclose = () => {
      if (named) return;
      setStatus("Pick a name to join.");
      again.hidden = false;
    };
    again.onclick = () => {
      again.hidden = true;
      setStatus("");
      dialog.showModal();
      input.select();
    };
    dialog.showModal();
    input.select();
  });
}

/** Camera and mic if we can; otherwise whichever works; otherwise just watch and chat. */
async function getMedia() {
  const video = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } };
  for (const constraints of [{ video, audio: true }, { audio: true }, { video }]) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn("getUserMedia", Object.keys(constraints).join("+"), err.name);
    }
  }
  return new MediaStream();
}

function wireCall() {
  call.addEventListener("peer-joined", ({ detail: { id, name } }) => {
    names.set(id, name);
    addTile(id, name);
    addMessage(`${name} joined`, { cls: "sys" });
  });
  call.addEventListener("peer-left", ({ detail: { id } }) => {
    if (names.has(id) && !ended) addMessage(`${names.get(id)} left`, { cls: "sys" });
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
  localStream = await getMedia();
  const media = { mic: localStream.getAudioTracks().length > 0, cam: localStream.getVideoTracks().length > 0 };
  if (!media.cam) Object.assign($("cam"), { disabled: true, textContent: "No camera" });
  if (!media.mic) Object.assign($("mic"), { disabled: true, textContent: "No mic" });

  addTile("self", name).querySelector("video").srcObject = localStream;
  setTileMedia("self", media);

  // ICE servers (including TURN) arrive with the room's welcome.
  call = new MeshCall({ forceRelay, sendSignal: (msg) => signaling.send(msg) });
  call.start(localStream);
  call.setMediaState(media);
  wireCall();

  signaling = openSignaling(roomId, {
    onOpen: () => {
      if (!reconnecting) setStatus("Joining…");
      signaling.send({ type: "join", name, resume: me ?? undefined });
    },
    onMessage: (msg) => {
      if (msg.type === "full") {
        if (reconnecting) return; // temporary while we're coming back; signaling retries
        return end(`This room is full (${MAX_PEOPLE} people max).`);
      }
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
  const button = e.currentTarget; // gone once we await
  try {
    await navigator.clipboard.writeText(location.origin + location.pathname);
    button.textContent = "Copied!";
  } catch {
    button.textContent = "Couldn't copy";
  }
  setTimeout(() => (button.textContent = "Copy link"), 1500);
};
$("leave").onclick = async () => {
  ended = true;
  call?.leave();
  localStream?.getTracks().forEach((t) => t.stop());
  await signaling?.close(me ?? undefined); // says goodbye even mid-reconnect
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
