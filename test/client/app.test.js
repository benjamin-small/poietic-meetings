// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, fakeLocalStorage, fakeLocation, mediaStream, loadHtml, settle } from "./page.js";

// app.js is the page: these tests drive it through fake signaling and a fake
// call, and check what it does with the DOM. signaling.js and mesh.js have
// their own tests.
const fake = vi.hoisted(() => ({ signaling: null, call: null }));

vi.mock("/chat/signaling.js", () => ({
  openSignaling: (roomId, handlers) => {
    fake.signaling = {
      roomId,
      ...handlers,
      sent: [],
      outage: null,
      send(msg) {
        this.sent.push(msg);
      },
      recovered() {
        return this.outage;
      },
      close: vi.fn(async () => {}),
    };
    return fake.signaling;
  },
}));

vi.mock("/chat/mesh.js", () => ({
  MeshCall: class extends EventTarget {
    constructor(opts) {
      super();
      this.opts = opts;
      this.signals = [];
      this.mediaStates = [];
      this.chatReach = 1; // what sendChat returns: how many peers got it
      this.chats = [];
      this.leave = vi.fn();
      fake.call = this;
    }
    start(stream) {
      this.stream = stream;
    }
    handleSignal(msg) {
      this.signals.push(msg);
    }
    setMediaState(media) {
      this.mediaStates.push(media);
    }
    sendChat(text) {
      this.chats.push(text);
      return this.chatReach;
    }
    emit(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
  },
}));

const ROOM_ID = "0b5c6a64-56a2-4c43-9d58-8b0d6a3c2f11";
const ROOM_URL = `https://tinkers.poietic.tech/chat/r/${ROOM_ID}`;

let fetch;
let loc;
let getUserMedia;
let clipboard;

beforeEach(() => {
  vi.resetModules();
  fake.signaling = fake.call = null;
  fakeLocalStorage();
  loadHtml("room.html");
  fetch = fakeFetch();
  loc = fakeLocation(ROOM_URL);
  getUserMedia = vi.fn(async () => mediaStream("audio", "video"));
  clipboard = { writeText: vi.fn(async () => {}) };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia }, clipboard });
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const $ = (id) => document.getElementById(id);
const status = () => $("status").textContent;
const tileFor = (id) => document.querySelector(`.tile[data-id="${id}"]`);
const messages = () => [...$("messages").children].map((li) => li.textContent);
const reports = () => fetch.to("/chat/report").map((r) => r.body);

/** Open the room page and, unless told not to, join as `name`. */
async function openRoom({ name = "Ada", join = true } = {}) {
  await import("../../public/chat/app.js");
  if (!join) return;
  $("name-input").value = name;
  $("join-form").requestSubmit();
  await settle();
}

/** Join, connect to signaling and get welcomed, with `peers` already in the room. */
async function inRoom(peers = [], opts) {
  await openRoom(opts);
  fake.signaling.onOpen();
  fake.signaling.onMessage({ type: "welcome", id: "me", token: "tok", resumed: false, peers });
  for (const { id, name } of peers) fake.call.emit("peer-joined", { id, name });
}

describe("joining", () => {
  it("sends you back to the lobby from a malformed room URL", async () => {
    fakeLocation("https://tinkers.poietic.tech/chat/r/not-a-room");
    await openRoom({ join: false });
    expect(location.replace).toHaveBeenCalledWith("/chat");
  });

  it("asks for a name first, suggesting a guest name", async () => {
    await openRoom({ join: false });
    expect($("join-dialog").open).toBe(true);
    expect($("name-input").value).toBe("Guest 1000");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fake.signaling).toBeNull();
  });

  it("remembers the name for next time", async () => {
    await openRoom({ name: "  Ada Lovelace  " });
    expect(localStorage.getItem("tinker-chat-name")).toBe("Ada Lovelace");

    vi.resetModules();
    loadHtml("room.html");
    await openRoom({ join: false });
    expect($("name-input").value).toBe("Ada Lovelace");
  });

  it("offers a Join button if the dialog is dismissed without a name", async () => {
    await openRoom({ join: false });
    $("join-dialog").close();
    expect(status()).toBe("Pick a name to join.");
    expect($("join-again").hidden).toBe(false);

    $("join-again").click();
    expect($("join-dialog").open).toBe(true);
    expect($("join-again").hidden).toBe(true);
    expect(status()).toBe("");
  });

  it("starts the camera, shows you, and joins the room under your name", async () => {
    await openRoom();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(tileFor("self").querySelector(".name").textContent).toBe("Ada (you)");
    expect(tileFor("self").querySelector("video").muted).toBe(true);
    expect(fake.call.stream).toBe(tileFor("self").querySelector("video").srcObject);
    expect(fake.signaling.roomId).toBe(ROOM_ID);

    fake.signaling.onOpen();
    expect(status()).toBe("Joining…");
    expect(fake.signaling.sent).toEqual([{ type: "join", name: "Ada", resume: undefined }]);
  });

  it("passes ?relay=1 on to the call", async () => {
    fakeLocation(`${ROOM_URL}?relay=1`);
    await openRoom();
    expect(fake.call.opts.forceRelay).toBe(true);
  });

  it("joins with just the mic when there's no camera", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error(), { name: "NotFoundError" }));
    getUserMedia.mockResolvedValueOnce(mediaStream("audio"));
    await openRoom();
    expect(getUserMedia.mock.calls.map(([c]) => Object.keys(c).join("+"))).toEqual(["video+audio", "audio"]);
    expect($("cam").disabled).toBe(true);
    expect($("cam").textContent).toBe("No camera");
    expect($("mic").disabled).toBe(false);
    expect(fake.call.mediaStates).toEqual([{ mic: true, cam: false }]);
    expect(tileFor("self").classList.contains("cam-off")).toBe(true);
  });

  it("still joins to watch and chat when no camera or mic is allowed", async () => {
    getUserMedia.mockRejectedValue(Object.assign(new Error(), { name: "NotAllowedError" }));
    await openRoom();
    expect(getUserMedia).toHaveBeenCalledTimes(3);
    expect($("cam").disabled && $("mic").disabled).toBe(true);
    expect(fake.signaling).not.toBeNull();
  });
});

describe("in the room", () => {
  it("passes every signaling message to the call", async () => {
    await inRoom();
    fake.signaling.onMessage({ type: "offer", from: "b" });
    expect(fake.call.signals.map((m) => m.type)).toEqual(["welcome", "offer"]);
  });

  it("asks you to share the link while you're alone", async () => {
    await inRoom();
    expect(status()).toBe("Waiting for others… Share the link!");
    expect($("count").textContent).toBe("1 of 6");
  });

  it("adds a tile and a message when someone joins, and removes them when they leave", async () => {
    await inRoom();
    fake.call.emit("peer-joined", { id: "b", name: "grace hopper" });
    expect(tileFor("b").querySelector(".name").textContent).toBe("grace hopper");
    expect(tileFor("b").querySelector(".avatar").textContent).toBe("GH");
    expect($("grid").dataset.count).toBe("2");
    expect($("count").textContent).toBe("2 of 6");
    expect(status()).toBe("");

    fake.call.emit("peer-left", { id: "b" });
    expect(tileFor("b")).toBeNull();
    expect(messages()).toEqual(["grace hopper joined", "grace hopper left"]);
    expect(status()).toBe("Waiting for others… Share the link!");
  });

  it("shows their video when it arrives", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    const stream = mediaStream("video");
    fake.call.emit("stream", { id: "b", stream });
    expect(tileFor("b").querySelector("video").srcObject).toBe(stream);
  });

  it("shows connection progress on the tile and reports failures", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.call.emit("state", { id: "b", state: "connecting" });
    expect(tileFor("b").querySelector(".state").textContent).toBe("Connecting…");

    fake.call.emit("state", { id: "b", state: "failed", diag: { ice: "failed", local: "host" } });
    expect(tileFor("b").querySelector(".state").textContent).toBe("Couldn't connect");
    expect(tileFor("b").classList.contains("failed")).toBe(true);
    expect(reports()).toEqual([
      { event: "peer-failed", room: ROOM_ID, peer: "me", peers: 1, remote: "b", ice: "failed", local: "host" },
    ]);

    fake.call.emit("state", { id: "b", state: "connected" });
    expect(tileFor("b").querySelector(".state").textContent).toBe("");
    expect(tileFor("b").classList.contains("failed")).toBe(false);
  });

  it("shows when someone mutes or turns their camera off", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.call.emit("media", { id: "b", mic: false, cam: false });
    expect(tileFor("b").querySelector(".muted").hidden).toBe(false);
    expect(tileFor("b").classList.contains("cam-off")).toBe(true);
    fake.call.emit("media", { id: "b", mic: true, cam: true });
    expect(tileFor("b").querySelector(".muted").hidden).toBe(true);
    expect(tileFor("b").classList.contains("cam-off")).toBe(false);
  });
});

describe("chat", () => {
  it("opens once there's a chat connection, and closes when there isn't", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    expect($("chat-input").disabled).toBe(true);
    fake.call.emit("channels", { open: 1 });
    expect($("chat-input").disabled).toBe(false);
    expect($("chat-input").placeholder).toBe("Say something…");
    fake.call.emit("channels", { open: 0 });
    expect($("chat-input").disabled).toBe(true);
    expect($("chat-input").placeholder).toBe("Waiting for others…");
  });

  it("sends what you type and shows it as yours", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.call.emit("channels", { open: 1 });
    $("chat-input").value = "  hello  ";
    $("chat-form").requestSubmit();
    expect(fake.call.chats).toEqual(["hello"]);
    expect(messages().at(-1)).toBe("You hello");
    expect($("chat-input").value).toBe("");
  });

  it("keeps your text if nobody could receive it, and ignores blank messages", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.call.emit("channels", { open: 1 });
    fake.call.chatReach = 0;
    $("chat-input").value = "hello";
    $("chat-form").requestSubmit();
    expect($("chat-input").value).toBe("hello");

    $("chat-input").value = "   ";
    $("chat-form").requestSubmit();
    expect(fake.call.chats).toEqual(["hello"]);
    expect(messages()).toEqual(["B joined"]);
  });

  it("shows incoming messages under the sender's name, as text", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.call.emit("chat", { id: "b", text: "<img src=x onerror=alert(1)>" });
    const li = $("messages").lastElementChild;
    expect(li.querySelector("strong").textContent).toBe("B");
    expect(li.textContent).toBe("B <img src=x onerror=alert(1)>");
    expect(li.querySelector("img")).toBeNull();
  });

  it("keeps only the latest 200 messages", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    for (let i = 0; i < 250; i++) fake.call.emit("chat", { id: "b", text: `m${i}` });
    expect(messages()).toHaveLength(200);
    expect(messages()[0]).toBe("B m50");
  });
});

describe("controls", () => {
  it("mutes and unmutes the mic, and tells the call", async () => {
    await inRoom();
    const audio = fake.call.stream.getAudioTracks()[0];
    $("mic").click();
    expect(audio.enabled).toBe(false);
    expect($("mic").textContent).toBe("Mic off");
    expect($("mic").classList.contains("off")).toBe(true);
    expect(tileFor("self").querySelector(".muted").hidden).toBe(false);
    expect(fake.call.mediaStates.at(-1)).toEqual({ mic: false, cam: true });

    $("mic").click();
    expect(audio.enabled).toBe(true);
    expect($("mic").textContent).toBe("Mic on");
    expect(fake.call.mediaStates.at(-1)).toEqual({ mic: true, cam: true });
  });

  it("turns the camera off and on", async () => {
    await inRoom();
    $("cam").click();
    expect(fake.call.stream.getVideoTracks()[0].enabled).toBe(false);
    expect($("cam").textContent).toBe("Cam off");
    expect(tileFor("self").classList.contains("cam-off")).toBe(true);
    expect(fake.call.mediaStates.at(-1)).toEqual({ mic: true, cam: false });
  });

  it("copies the room link without its query string", async () => {
    fakeLocation(`${ROOM_URL}?relay=1`);
    await inRoom();
    vi.useFakeTimers();
    $("copy").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(clipboard.writeText).toHaveBeenCalledWith(ROOM_URL);
    expect($("copy").textContent).toBe("Copied!");
    await vi.advanceTimersByTimeAsync(1500);
    expect($("copy").textContent).toBe("Copy link");
  });

  it("says so when the link can't be copied", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    await inRoom();
    $("copy").click();
    await settle();
    expect($("copy").textContent).toBe("Couldn't copy");
  });

  it("leaving stops the camera, ends the calls, says goodbye and goes to the lobby", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    const tracks = fake.call.stream.getTracks();
    $("leave").click();
    await settle();
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(fake.call.leave).toHaveBeenCalled();
    expect(fake.signaling.close).toHaveBeenCalledWith({ id: "me", token: "tok" });
    expect(loc.href).toBe("/chat");
  });
});

describe("the room turning you away", () => {
  it("ends the call when the room is full", async () => {
    await openRoom();
    const tracks = fake.call.stream.getTracks();
    fake.signaling.onOpen();
    fake.signaling.onMessage({ type: "full" });
    expect(status()).toBe("This room is full (6 people max).");
    expect(fake.call.leave).toHaveBeenCalled();
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
  });

  it("ends the call when the room doesn't exist", async () => {
    await openRoom();
    fake.signaling.onMessage({ type: "not-found" });
    expect(status()).toBe("This room doesn't exist or has expired.");
    expect(fake.call.leave).toHaveBeenCalled();
  });

  it("doesn't announce departures once the call has ended", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.signaling.onMessage({ type: "not-found" });
    fake.call.emit("peer-left", { id: "b" });
    expect(messages()).toEqual(["B joined"]);
    expect(status()).toBe("This room doesn't exist or has expired.");
  });
});

describe("reconnecting", () => {
  const drop = { code: 1006, wasClean: false, online: true, visible: true };

  it("says it's reconnecting, reports the drop, and resumes with the same identity", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.signaling.onDrop(drop);
    expect(status()).toBe("Reconnecting to the room… (video continues)");
    expect(reports()).toEqual([expect.objectContaining({ event: "ws-close", ...drop, peer: "me" })]);
    expect(reports()[0].inCallMs).toBeGreaterThanOrEqual(0);

    fake.signaling.onOpen();
    expect(status()).toBe("Reconnecting to the room… (video continues)");
    expect(fake.signaling.sent.at(-1)).toEqual({ type: "join", name: "Ada", resume: { id: "me", token: "tok" } });
  });

  it("reports the outage once it's back, then clears the status", async () => {
    await inRoom([{ id: "b", name: "B" }]);
    fake.signaling.onDrop(drop);
    fake.signaling.outage = { downMs: 4200, attempts: 3 };
    fake.signaling.onMessage({ type: "welcome", id: "me", token: "tok", resumed: true, peers: [{ id: "b", name: "B" }] });
    expect(reports().at(-1)).toEqual(
      expect.objectContaining({ event: "reconnected", ...drop, downMs: 4200, attempts: 3, resumed: true }),
    );
    expect(status()).toBe("");
  });

  it("keeps waiting if the room is briefly full while coming back", async () => {
    await inRoom();
    fake.signaling.onDrop(drop);
    fake.signaling.onMessage({ type: "full" });
    expect(fake.call.leave).not.toHaveBeenCalled();
    expect(status()).toBe("Reconnecting to the room… (video continues)");
  });

  it("gives up with a reload hint once signaling does", async () => {
    await inRoom();
    fake.signaling.onDrop(drop);
    fake.signaling.onGiveUp({ downMs: 120000, attempts: 12 });
    expect(status()).toBe("Lost the connection to the room. Reload to rejoin.");
    expect(fake.call.leave).toHaveBeenCalled();
    expect(reports().at(-1)).toEqual(expect.objectContaining({ event: "gave-up", downMs: 120000, attempts: 12, code: 1006 }));
  });
});
