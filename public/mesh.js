// The call layer, mesh edition: one RTCPeerConnection + chat channel per
// remote peer. app.js only uses the interface below, so an SFU-backed class
// with the same shape can replace this one without touching the UI.
//
//   const call = new MeshCall({ forceRelay, sendSignal });  // ICE servers come in welcome
//   call.start(localStream);
//   call.handleSignal(msg);           // every message from signaling.js
//   call.sendChat(text) -> number     // peers it went to
//   call.setMediaState({ mic, cam, screen })  // tell peers our mute and sharing state
//   call.setVideoTrack(track)         // send this as our video instead (a screen, or the camera back)
//   call.leave();
//
// Events (CustomEvent, data in .detail):
//   peer-joined {id, name}   peer-left {id}   stream {id, stream}
//   state {id, state: "connecting"|"connected"|"failed", diag?}  diag only on failure
//   chat {id, text}   media {id, mic, cam, screen}   channels {open}
//
// Connections that fail, or never come up because signaling was lost (e.g.
// while our socket was down), are started over with a fresh offer. If both
// sides offer at once, the side with the lower id is "polite" and gives way;
// the other ignores the crossing offer (WebRTC "perfect negotiation"). Each
// offer carries an id its answer echoes, so a late answer to an offer we've
// since replaced is ignored rather than applied to the new connection.
//
// Every connection has exactly one video slot we can send on, even without a
// camera, so sharing a screen is a replaceTrack on that slot: no new offer,
// which matters because any offer here starts a fresh connection.

const CONNECT_TIMEOUT_MS = 15000; // ICE can sit in "connecting" forever instead of failing
const MAX_RETRIES = 3; // fresh offers per peer before leaving it at "Couldn't connect"
const RETRY_DELAY_MS = 1000; // grows per attempt, plus jitter so both sides rarely retry at once
const MAX_PENDING = 50; // candidates buffered before an offer; real connections need far fewer
const CHAT_PER_SECOND = 10; // per peer; more than that is dropped
const UPLOAD_BUDGET_BPS = 1_500_000; // total video upload, shared across peers
const MIN_VIDEO_BPS = 250_000;
const SCREEN_UPLOAD_BUDGET_BPS = 2_500_000; // more while sharing a screen, so text stays legible
const MIN_SCREEN_BPS = 500_000;
const CHAT_MAX = 2000;

export class MeshCall extends EventTarget {
  #peers = new Map(); // id -> { name, pc, channel, pending, timer, retries, failed, chatWindow, chatCount }
  #queue = Promise.resolve();
  #media = { mic: true, cam: true, screen: false };
  #video = null; // what we send as video: the camera, a screen, or nothing
  #selfId = null;

  constructor({ iceServers = [], forceRelay, sendSignal }) {
    super();
    this.config = { iceServers, iceTransportPolicy: forceRelay ? "relay" : "all" };
    this.sendSignal = sendSignal;
  }

  start(stream) {
    this.stream = stream;
    this.#video = stream.getTracks().find((t) => t.kind === "video") ?? null;
  }

  get peerCount() {
    return this.#peers.size;
  }

  /** Signaling messages are handled strictly in order, one at a time. */
  handleSignal(msg) {
    return this.#enqueue(() => this.#handle(msg), msg.type);
  }

  #enqueue(fn, label) {
    this.#queue = this.#queue.then(fn).catch((err) => console.error("signal", label, err));
    return this.#queue;
  }

  sendChat(text) {
    return this.#broadcast({ t: "chat", text });
  }

  setMediaState(media) {
    this.#media = { ...this.#media, ...media };
    this.#broadcast({ t: "media", ...this.#media });
    this.#applyBitrate();
  }

  /** Send `track` (or nothing, for null) as our video on every connection, now and later. */
  setVideoTrack(track) {
    return this.#enqueue(async () => {
      this.#video = track;
      for (const { pc } of this.#peers.values()) {
        await this.#videoSlot(pc)?.sender.replaceTrack(track).catch(console.warn);
      }
      this.#applyBitrate();
    }, "video");
  }

  leave() {
    for (const id of [...this.#peers.keys()]) this.#remove(id);
  }

  async #handle(msg) {
    switch (msg.type) {
      case "welcome": {
        this.#selfId = msg.id;
        if (msg.iceServers) this.config.iceServers = msg.iceServers;
        if (msg.resumed) {
          // Back after a dropped connection with our old identity. Calls
          // that survived stay as they are, and whoever left meanwhile is
          // gone. Everyone else gets a fresh offer: people who arrived while
          // we couldn't hear, and calls whose signaling was lost or that
          // died with the network. A crossing offer is settled by roles.
          const present = new Set(msg.peers.map((p) => p.id));
          for (const id of [...this.#peers.keys()]) if (!present.has(id)) this.#remove(id);
          for (const { id, name } of msg.peers) {
            const peer = this.#peers.get(id);
            // Someone who arrived while we were away: the room tells them we're
            // back (peer-resumed) and they offer again, so wait for that.
            if (!peer) this.#add(id, name);
            else if (peer.pc.connectionState !== "connected") await this.#offerTo(id, name, { silent: true });
          }
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
      case "peer-resumed": {
        // They were away; whatever we were negotiating with them may be lost.
        const peer = this.#peers.get(msg.id);
        if (peer && peer.pc.connectionState !== "connected") await this.#offerTo(msg.id, peer.name, { silent: true });
        break;
      }
      case "offer": {
        let peer = this.#peers.get(msg.from);
        if (!peer) return;
        const { pc } = peer;
        // Both sides offered at once: the impolite side keeps its own offer
        // and ignores theirs; the polite side gives way and answers.
        if (pc.signalingState !== "stable" && !this.#polite(msg.from)) return;
        // Any offer starts a fresh connection, unless this one is brand new
        // and waiting for exactly this offer (created on peer-joined).
        if (pc.signalingState !== "stable" || pc.remoteDescription || pc.connectionState === "closed") {
          peer = this.#add(msg.from, peer.name, { silent: true, retries: peer.retries });
        }
        await peer.pc.setRemoteDescription(msg.sdp);
        await this.#flush(peer);
        await this.#openVideoSlot(peer.pc);
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        this.sendSignal({ type: "answer", to: msg.from, sdp: peer.pc.localDescription, nid: msg.nid });
        break;
      }
      case "answer": {
        const peer = this.#peers.get(msg.from);
        // Ignore an answer to an offer we've since replaced.
        if (!peer || peer.pc.signalingState !== "have-local-offer" || msg.nid !== peer.nid) return;
        await peer.pc.setRemoteDescription(msg.sdp);
        await this.#flush(peer);
        break;
      }
      case "candidate": {
        const peer = this.#peers.get(msg.from);
        if (!peer) return;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.candidate).catch(console.warn);
        else if (peer.pending.length < MAX_PENDING) peer.pending.push(msg.candidate);
        break;
      }
      case "peer-left":
        this.#remove(msg.id);
        break;
    }
  }

  #polite(id) {
    return this.#selfId < id;
  }

  /** Offer a new connection. `silent` replaces an existing one without join/leave events. */
  async #offerTo(id, name, { silent = false } = {}) {
    const peer = this.#add(id, name, { silent, retries: this.#peers.get(id)?.retries ?? 0 });
    // Without a mic we still want to hear them. Without a camera we still want
    // to see them, and keep a slot to send a screen on later.
    const kinds = peer.pc.getTransceivers().map((t) => t.receiver.track.kind);
    if (!kinds.includes("audio")) peer.pc.addTransceiver("audio", { direction: "recvonly" });
    if (!kinds.includes("video")) peer.pc.addTransceiver("video", { direction: "sendrecv", streams: [this.stream] });
    this.#setupChannel(id, peer.pc.createDataChannel("chat"));
    peer.nid = crypto.randomUUID();
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    this.sendSignal({ type: "offer", to: id, sdp: peer.pc.localDescription, nid: peer.nid });
  }

  /** New connection to a peer. `silent` replaces an existing one without join/leave events. */
  #add(id, name, { silent = false, retries = 0 } = {}) {
    if (silent) this.#close(id);
    else this.#remove(id);
    const pc = new RTCPeerConnection(this.config);
    const peer = { name, pc, channel: null, pending: [], timer: 0, retries, failed: false, chatWindow: 0, chatCount: 0 };
    this.#peers.set(id, peer);
    // When they offer, their offer reuses these; #offerTo and #openVideoSlot
    // fill in whatever we don't have.
    for (const track of this.stream.getTracks()) if (track.kind === "audio") pc.addTrack(track, this.stream);
    if (this.#video) pc.addTrack(this.#video, this.stream);

    pc.onicecandidate = (e) => e.candidate && this.sendSignal({ type: "candidate", to: id, candidate: e.candidate });
    pc.ontrack = (e) => {
      // A track that comes without a stream (their video slot, where the
      // browser can't set one) joins the stream their other track came in.
      if (e.streams[0]) peer.remote = e.streams[0];
      else (peer.remote ??= new MediaStream()).addTrack(e.track);
      this.#emit("stream", { id, stream: peer.remote });
    };
    pc.ondatachannel = (e) => this.#setupChannel(id, e.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        clearTimeout(peer.timer);
        peer.retries = 0;
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

  /** The one video transceiver we send on, once there is one. */
  #videoSlot(pc) {
    return pc
      .getTransceivers()
      .find((t) => t.receiver.track.kind === "video" && (t.direction === "sendrecv" || t.direction === "sendonly"));
  }

  /**
   * Answering without a camera: the offer's video line made a recvonly
   * transceiver. Make it able to send before we answer, so a screen can go
   * out on it later without renegotiating.
   */
  async #openVideoSlot(pc) {
    if (this.#videoSlot(pc)) return;
    const slot = pc.getTransceivers().find((t) => t.mid !== null && t.receiver.track.kind === "video");
    if (!slot) return;
    slot.direction = "sendrecv";
    slot.sender.setStreams?.(this.stream); // so their side files it with our audio
    if (this.#video) await slot.sender.replaceTrack(this.#video);
  }

  /** Why a connection failed, without anything identifying: states and candidate kinds. */
  async #fail(id, pc) {
    const peer = this.#peers.get(id);
    if (peer?.pc !== pc || peer.failed) return; // replaced, or already reported
    peer.failed = true;
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
    this.#retry(id, pc);
  }

  /** Start over with a fresh offer, a few times. A crossing retry from them is settled by roles. */
  #retry(id, pc) {
    const peer = this.#peers.get(id);
    if (peer?.pc !== pc || peer.retries >= MAX_RETRIES) return;
    peer.retries++;
    const delay = RETRY_DELAY_MS * peer.retries + Math.random() * RETRY_DELAY_MS;
    setTimeout(() => {
      this.#enqueue(async () => {
        const current = this.#peers.get(id);
        if (current?.pc !== pc) return; // they started over first
        if (pc.connectionState === "connected") return; // it came up after all
        await this.#offerTo(id, current.name, { silent: true });
      }, "retry");
    }, delay);
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
        if (!this.#allowChat(id)) return;
        this.#emit("chat", { id, text: msg.text.slice(0, CHAT_MAX) });
      } else if (msg.t === "media") {
        this.#emit("media", { id, mic: msg.mic !== false, cam: msg.cam !== false, screen: msg.screen === true });
      }
    };
  }

  /** A peer may send CHAT_PER_SECOND messages per second; a flood beyond that is dropped. */
  #allowChat(id) {
    const peer = this.#peers.get(id);
    if (!peer) return false;
    const now = Date.now();
    if (now - peer.chatWindow >= 1000) {
      peer.chatWindow = now;
      peer.chatCount = 0;
    }
    return ++peer.chatCount <= CHAT_PER_SECOND;
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
    const [budget, min] = this.#media.screen ? [SCREEN_UPLOAD_BUDGET_BPS, MIN_SCREEN_BPS] : [UPLOAD_BUDGET_BPS, MIN_VIDEO_BPS];
    const bps = Math.max(min, Math.floor(budget / Math.max(1, this.#peers.size)));
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
