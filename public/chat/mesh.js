// The call layer, mesh edition: one RTCPeerConnection + chat channel per
// remote peer. app.js only uses the interface below, so an SFU-backed class
// with the same shape can replace this one without touching the UI.
//
//   const call = new MeshCall({ iceServers, forceRelay, sendSignal });
//   call.start(localStream);
//   call.handleSignal(msg);           // every message from signaling.js
//   call.sendChat(text) -> number     // peers it went to
//   call.setMediaState({ mic, cam })  // tell peers our mute state
//   call.leave();
//
// Events (CustomEvent, data in .detail):
//   peer-joined {id, name}   peer-left {id}   stream {id, stream}
//   state {id, state: "connecting"|"connected"|"failed", diag?}  diag only on failure
//   chat {id, text}   media {id, mic, cam}   channels {open}

const CONNECT_TIMEOUT_MS = 15000; // ICE can sit in "connecting" forever instead of failing
const UPLOAD_BUDGET_BPS = 1_500_000; // total video upload, shared across peers
const MIN_VIDEO_BPS = 250_000;
const CHAT_MAX = 2000;

export class MeshCall extends EventTarget {
  #peers = new Map(); // id -> { name, pc, channel, pending, timer }
  #queue = Promise.resolve();
  #media = { mic: true, cam: true };

  constructor({ iceServers, forceRelay, sendSignal }) {
    super();
    this.config = { iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" };
    this.sendSignal = sendSignal;
  }

  start(stream) {
    this.stream = stream;
  }

  get peerCount() {
    return this.#peers.size;
  }

  /** Signaling messages are handled strictly in order, one at a time. */
  handleSignal(msg) {
    this.#queue = this.#queue.then(() => this.#handle(msg)).catch((err) => console.error("signal", msg.type, err));
    return this.#queue;
  }

  sendChat(text) {
    return this.#broadcast({ t: "chat", text });
  }

  setMediaState(media) {
    this.#media = { ...this.#media, ...media };
    this.#broadcast({ t: "media", ...this.#media });
  }

  leave() {
    for (const id of [...this.#peers.keys()]) this.#remove(id);
  }

  async #handle(msg) {
    switch (msg.type) {
      case "welcome": {
        if (msg.resumed) {
          // Back after a dropped connection with our old identity. Calls
          // that survived stay as they are. Whoever left meanwhile is gone;
          // whoever arrived meanwhile offered to us while we couldn't hear,
          // so we offer to them (they'll replace their stalled attempt).
          const present = new Set(msg.peers.map((p) => p.id));
          for (const id of [...this.#peers.keys()]) if (!present.has(id)) this.#remove(id);
          for (const { id, name } of msg.peers) if (!this.#peers.has(id)) await this.#offerTo(id, name);
        } else {
          // A fresh identity: any calls we had belong to the old one.
          for (const id of [...this.#peers.keys()]) this.#remove(id);
          // We're the newcomer: we offer to everyone already here.
          for (const { id, name } of msg.peers) await this.#offerTo(id, name);
        }
        break;
      }
      case "peer-joined":
        this.#add(msg.id, msg.name); // they'll send the offer
        break;
      case "offer": {
        let peer = this.#peers.get(msg.from);
        if (!peer) return;
        // A fresh offer while ours is pending or the call is dead means they
        // are starting over (e.g. they reconnected); start over with them.
        const { signalingState, connectionState } = peer.pc;
        if (signalingState !== "stable" || connectionState === "failed" || connectionState === "closed") {
          peer = this.#add(msg.from, peer.name, { silent: true });
        }
        await peer.pc.setRemoteDescription(msg.sdp);
        await this.#flush(peer);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.sendSignal({ type: "answer", to: msg.from, sdp: peer.pc.localDescription });
        break;
      }
      case "answer": {
        const peer = this.#peers.get(msg.from);
        if (!peer) return;
        await peer.pc.setRemoteDescription(msg.sdp);
        await this.#flush(peer);
        break;
      }
      case "candidate": {
        const peer = this.#peers.get(msg.from);
        if (!peer) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.candidate).catch(console.warn);
        else peer.pending.push(msg.candidate);
        break;
      }
      case "peer-left":
        this.#remove(msg.id);
        break;
    }
  }

  async #offerTo(id, name) {
    const peer = this.#add(id, name);
    this.#setupChannel(id, peer.pc.createDataChannel("chat"));
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    this.sendSignal({ type: "offer", to: id, sdp: peer.pc.localDescription });
  }

  /** New connection to a peer. `silent` replaces an existing one without join/leave events. */
  #add(id, name, { silent = false } = {}) {
    if (silent) this.#close(id);
    else this.#remove(id);
    const pc = new RTCPeerConnection(this.config);
    const peer = { name, pc, channel: null, pending: [], timer: 0 };
    this.#peers.set(id, peer);
    for (const track of this.stream.getTracks()) pc.addTrack(track, this.stream);

    pc.onicecandidate = (e) => e.candidate && this.sendSignal({ type: "candidate", to: id, candidate: e.candidate });
    pc.ontrack = (e) => this.#emit("stream", { id, stream: e.streams[0] });
    pc.ondatachannel = (e) => this.#setupChannel(id, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(peer.timer);
        this.#emit("state", { id, state: "connected" });
        this.#applyBitrate(); // encodings may not have existed before negotiation
      } else if (pc.connectionState === "failed") {
        clearTimeout(peer.timer);
        this.#fail(id, pc);
      }
    };
    peer.timer = setTimeout(() => {
      if (pc.connectionState !== "connected") this.#fail(id, pc);
    }, CONNECT_TIMEOUT_MS);

    if (!silent) this.#emit("peer-joined", { id, name });
    this.#emit("state", { id, state: "connecting" });
    this.#applyBitrate();
    return peer;
  }

  /** Why a connection failed, without anything identifying: states and candidate kinds. */
  async #fail(id, pc) {
    const kinds = {};
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type === "local-candidate") kinds[r.candidateType] = (kinds[r.candidateType] ?? 0) + 1;
      });
    } catch {}
    if (this.#peers.get(id)?.pc !== pc) return; // replaced meanwhile
    const diag = {
      iceState: pc.iceConnectionState,
      connState: pc.connectionState,
      localCandidates: Object.entries(kinds).map(([k, n]) => `${k}:${n}`).join(",") || "none",
    };
    this.#emit("state", { id, state: "failed", diag });
  }

  #close(id) {
    const peer = this.#peers.get(id);
    if (!peer) return false;
    clearTimeout(peer.timer);
    peer.pc.close();
    this.#peers.delete(id);
    return true;
  }

  #remove(id) {
    if (!this.#close(id)) return;
    this.#emit("peer-left", { id });
    this.#emit("channels", { open: this.#openChannels().length });
    this.#applyBitrate();
  }

  #setupChannel(id, channel) {
    const peer = this.#peers.get(id);
    if (!peer) return;
    peer.channel = channel;
    channel.onopen = () => {
      channel.send(JSON.stringify({ t: "media", ...this.#media }));
      this.#emit("channels", { open: this.#openChannels().length });
    };
    channel.onclose = () => this.#emit("channels", { open: this.#openChannels().length });
    channel.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === "chat" && typeof msg.text === "string") {
        this.#emit("chat", { id, text: msg.text.slice(0, CHAT_MAX) });
      } else if (msg.t === "media") {
        this.#emit("media", { id, mic: msg.mic !== false, cam: msg.cam !== false });
      }
    };
  }

  async #flush(peer) {
    for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(console.warn);
    peer.pending = [];
  }

  #openChannels() {
    return [...this.#peers.values()].filter((p) => p.channel?.readyState === "open");
  }

  #broadcast(msg) {
    const open = this.#openChannels();
    const data = JSON.stringify(msg);
    for (const p of open) p.channel.send(data);
    return open.length;
  }

  // Mesh sends a separate video stream to every peer, so split the upload
  // budget between them.
  #applyBitrate() {
    const bps = Math.max(MIN_VIDEO_BPS, Math.floor(UPLOAD_BUDGET_BPS / Math.max(1, this.#peers.size)));
    for (const { pc } of this.#peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== "video") continue;
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = bps;
        sender.setParameters(params).catch(() => {});
      }
    }
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
