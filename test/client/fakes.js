// Test doubles for the browser APIs the client modules use. The peer
// connection enforces WebRTC's signaling-state rules (an answer in the wrong
// state throws, like a real browser), which is what the glare and recovery
// tests depend on.

export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  /** @type {FakeWebSocket[]} */
  static all = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.all.push(this);
  }

  send(data) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("InvalidStateError: not open");
    this.sent.push(data);
  }

  /** Like a browser: closing is immediate on our side, the close event comes later. */
  close(code = 1000, reason = "") {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closedWith = { code, reason };
    setTimeout(() => this.onclose?.({ code, wasClean: true }), 0);
  }

  // --- driven by tests ---
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(msg) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  /** The server or network ended the connection. */
  drop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, wasClean: code !== 1006 });
  }

  sentJson() {
    return this.sent.map((d) => JSON.parse(d));
  }
}

export class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = "connecting";
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
  }

  open() {
    this.readyState = "open";
    this.onopen?.();
  }

  receive(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

let pcCount = 0;

export class FakePeerConnection {
  /** @type {FakePeerConnection[]} */
  static all = [];

  constructor(config) {
    this.n = ++pcCount;
    this.config = config;
    this.signalingState = "stable";
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.senders = [];
    this.transceivers = [];
    this.channels = [];
    this.candidates = [];
    FakePeerConnection.all.push(this);
  }

  // Transceivers follow the browser's rules closely enough for the
  // screen-share tests: an incoming offer reuses a transceiver made by
  // addTrack, but not one made by addTransceiver, and makes a recvonly one
  // for any media it can't match.
  #transceiver(kind, { direction = "sendrecv", track = null, fromAddTrack = false } = {}) {
    const sender = {
      track,
      streams: [],
      replaceTrack: async (t) => void (sender.track = t),
      setStreams: (...streams) => void (sender.streams = streams),
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async (params) => void (sender.lastParams = params),
    };
    const transceiver = { mid: null, direction, sender, receiver: { track: { kind } }, fromAddTrack };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  addTrack(track, ...streams) {
    const { sender } = this.#transceiver(track.kind, { track, fromAddTrack: true });
    sender.streams = streams;
    return sender;
  }

  addTransceiver(kind, { direction, streams = [] } = {}) {
    const t = this.#transceiver(kind, { direction });
    t.sender.streams = streams;
    return t;
  }

  getTransceivers() {
    return this.transceivers;
  }

  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }

  /** What an offer from this connection would carry, one entry per m-line. */
  #media() {
    return this.transceivers.map((t, i) => {
      t.mid ??= String(i);
      return { kind: t.receiver.track.kind, direction: t.direction };
    });
  }

  createDataChannel(label) {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: `offer-from-pc${this.n}`, media: this.#media() };
  }

  async createAnswer() {
    if (this.signalingState !== "have-remote-offer") throw new Error(`InvalidStateError: createAnswer in ${this.signalingState}`);
    return { type: "answer", sdp: `answer-from-pc${this.n}` };
  }

  async setLocalDescription(desc) {
    if (desc.type === "offer") {
      if (this.signalingState !== "stable") throw new Error(`InvalidStateError: local offer in ${this.signalingState}`);
      this.signalingState = "have-local-offer";
    } else {
      if (this.signalingState !== "have-remote-offer") throw new Error(`InvalidStateError: local answer in ${this.signalingState}`);
      this.signalingState = "stable";
    }
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    if (desc.type === "offer") {
      if (this.signalingState !== "stable") throw new Error(`InvalidStateError: remote offer in ${this.signalingState}`);
      this.signalingState = "have-remote-offer";
      // Hand-written offers in tests default to one audio and one video line.
      for (const [i, { kind }] of (desc.media ?? [{ kind: "audio" }, { kind: "video" }]).entries()) {
        const reuse = this.transceivers.find((t) => t.mid === null && t.fromAddTrack && t.receiver.track.kind === kind);
        (reuse ?? this.#transceiver(kind, { direction: "recvonly" })).mid = String(i);
      }
    } else {
      if (this.signalingState !== "have-local-offer") throw new Error(`InvalidStateError: remote answer in ${this.signalingState}`);
      this.signalingState = "stable";
    }
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error("InvalidStateError: no remote description");
    this.candidates.push(candidate);
  }

  async getStats() {
    return new Map();
  }

  close() {
    this.signalingState = "closed";
    this.connectionState = "closed";
  }

  // --- driven by tests ---
  setConnectionState(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

export const stream = (...kinds) => {
  const tracks = kinds.map((kind) => ({ kind }));
  return { getTracks: () => tracks };
};
