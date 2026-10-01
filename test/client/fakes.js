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

  addTrack(track) {
    const sender = { track, getParameters: () => ({ encodings: [{}] }), setParameters: async () => {} };
    this.senders.push(sender);
    return sender;
  }

  addTransceiver(kind, init) {
    this.transceivers.push({ kind, ...init });
  }

  getSenders() {
    return this.senders;
  }

  createDataChannel(label) {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() {
    return { type: "offer", sdp: `offer-from-pc${this.n}` };
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

export const stream = (...kinds) => ({ getTracks: () => kinds.map((kind) => ({ kind })) });
