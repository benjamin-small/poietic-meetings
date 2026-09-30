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
//   state {id, state: "connecting"|"connected"|"failed"}
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
      case "welcome":
        // We're the newcomer: we offer to everyone already here.
        for (const { id, name } of msg.peers) {
          const peer = this.#add(id, name);
          this.#setupChannel(id, peer.pc.createDataChannel("chat"));
          await peer.pc.setLocalDescription(await peer.pc.createOffer());
          this.sendSignal({ type: "offer", to: id, sdp: peer.pc.localDescription });
        }
        break;
      case "peer-joined":
        this.#add(msg.id, msg.name); // they'll send the offer
        break;
      case "offer": {
        const peer = this.#peers.get(msg.from);
        if (!peer) return;
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

  #add(id, name) {
    this.#remove(id);
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
        this.#emit("state", { id, state: "failed" });
      }
    };
    peer.timer = setTimeout(() => {
      if (pc.connectionState !== "connected") this.#emit("state", { id, state: "failed" });
    }, CONNECT_TIMEOUT_MS);

    this.#emit("peer-joined", { id, name });
    this.#emit("state", { id, state: "connecting" });
    this.#applyBitrate();
    return peer;
  }

  #remove(id) {
    const peer = this.#peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timer);
    peer.pc.close();
    this.#peers.delete(id);
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
