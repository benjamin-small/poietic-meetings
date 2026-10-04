import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakePeerConnection, stream } from "./fakes.js";
import { MeshCall } from "../../public/chat/mesh.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  FakePeerConnection.all = [];
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A MeshCall plus everything it sends and emits. */
function makeCall(media = stream("audio", "video")) {
  const sent = [];
  const events = [];
  const call = new MeshCall({ forceRelay: false, sendSignal: (msg) => sent.push(msg) });
  for (const type of ["peer-joined", "peer-left", "state", "chat"]) {
    call.addEventListener(type, (e) => events.push({ type, ...e.detail }));
  }
  call.start(media);
  return { call, sent, events, offers: () => sent.filter((m) => m.type === "offer") };
}

const welcome = (id, peers, extra = {}) => ({ type: "welcome", id, token: "t", resumed: false, peers, ...extra });
/** The answer the other side sends back to one of our offers. */
const answerTo = (offer) => ({ type: "answer", from: offer.to, sdp: { type: "answer", sdp: "x" }, nid: offer.nid });

describe("MeshCall", () => {
  it("uses the ICE servers from the welcome", async () => {
    const { call } = makeCall();
    const iceServers = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }], { iceServers }));
    expect(FakePeerConnection.all[0].config.iceServers).toEqual(iceServers);
  });

  it("starts over with a fresh offer when a connection fails", async () => {
    const { call, offers, events } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    await call.handleSignal(answerTo(offers()[0]));
    FakePeerConnection.all[0].setConnectionState("failed");
    await vi.advanceTimersByTimeAsync(2000);
    expect(offers()).toHaveLength(2);
    expect(FakePeerConnection.all).toHaveLength(2);
    expect(events.filter((e) => e.type === "state" && e.state === "failed")).toHaveLength(1);
  });

  it("re-offers on resume when signaling was lost while we were away", async () => {
    const { call, offers } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    // Our socket dropped before B's answer arrived; we come back.
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }], { resumed: true }));
    expect(offers()).toHaveLength(2);
  });

  it("keeps connected calls as they are on resume", async () => {
    const { call, offers } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    await call.handleSignal(answerTo(offers()[0]));
    FakePeerConnection.all[0].setConnectionState("connected");
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }], { resumed: true }));
    expect(offers()).toHaveLength(1);
  });

  it("settles crossing offers: the polite side answers", async () => {
    const { call, sent } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }])); // "a" < "b": we're polite
    await call.handleSignal({ type: "offer", from: "b", sdp: { type: "offer", sdp: "theirs" } });
    expect(sent.filter((m) => m.type === "answer")).toHaveLength(1);
  });

  it("settles crossing offers: the impolite side ignores theirs", async () => {
    const { call, sent, offers } = makeCall();
    await call.handleSignal(welcome("z", [{ id: "b", name: "B" }])); // "z" > "b": impolite
    const ours = FakePeerConnection.all[0];
    await call.handleSignal({ type: "offer", from: "b", sdp: { type: "offer", sdp: "theirs" } });
    expect(sent.filter((m) => m.type === "answer")).toHaveLength(0);
    expect(ours.signalingState).toBe("have-local-offer");
    // Their answer to our offer still lands on our connection.
    await call.handleSignal(answerTo(offers()[0]));
    expect(ours.signalingState).toBe("stable");
  });

  it("ignores an answer to an offer it has since replaced", async () => {
    const { call, offers } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }], { resumed: true })); // offers again
    const [stale, current] = offers();
    const pc = FakePeerConnection.all.at(-1);
    await call.handleSignal(answerTo(stale)); // late answer to the first offer
    expect(pc.signalingState).toBe("have-local-offer");
    await call.handleSignal(answerTo(current));
    expect(pc.signalingState).toBe("stable");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("waits for offers from people who arrived while it was away", async () => {
    const { call, offers, events } = makeCall();
    await call.handleSignal(welcome("a", []));
    await call.handleSignal(welcome("a", [{ id: "n", name: "New" }], { resumed: true }));
    expect(offers()).toHaveLength(0);
    expect(events.filter((e) => e.type === "peer-joined").map((e) => e.id)).toEqual(["n"]);
  });

  it("restarts an unfinished call when that peer comes back", async () => {
    const { call, offers } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }])); // our offer to B goes unanswered
    await call.handleSignal({ type: "peer-resumed", id: "b" });
    expect(offers()).toHaveLength(2);
  });

  it("caps candidates buffered before an offer", async () => {
    const { call } = makeCall();
    await call.handleSignal(welcome("a", []));
    await call.handleSignal({ type: "peer-joined", id: "m", name: "Mallory" });
    for (let i = 0; i < 500; i++) {
      await call.handleSignal({ type: "candidate", from: "m", candidate: { candidate: `c${i}` } });
    }
    await call.handleSignal({ type: "offer", from: "m", sdp: { type: "offer", sdp: "x" } });
    expect(FakePeerConnection.all.at(-1).candidates.length).toBeLessThanOrEqual(50);
  });

  it("drops a chat flood beyond the per-peer rate limit", async () => {
    const { call, events } = makeCall();
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    const channel = FakePeerConnection.all[0].channels[0];
    channel.open();
    for (let i = 0; i < 100; i++) channel.receive({ t: "chat", text: `spam ${i}` });
    expect(events.filter((e) => e.type === "chat")).toHaveLength(10);
    vi.advanceTimersByTime(1000);
    channel.receive({ t: "chat", text: "later" });
    expect(events.filter((e) => e.type === "chat")).toHaveLength(11);
  });

  it("still receives audio and video without a camera or mic", async () => {
    const { call } = makeCall(stream());
    await call.handleSignal(welcome("a", [{ id: "b", name: "B" }]));
    expect(FakePeerConnection.all[0].transceivers).toEqual([
      { kind: "audio", direction: "recvonly" },
      { kind: "video", direction: "recvonly" },
    ]);
  });
});
