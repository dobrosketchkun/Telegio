import { log, warn } from "./log.js";
import { verifySignedValue } from "./identity.js";

const INTERNAL_ACTION = "__ephchat_mux_v1";
const BROADCAST = "*";
const MAX_HOPS = 5;
const MAX_PACKET_CHARS = 4 * 1024 * 1024;
const PACKET_MAX_AGE_MS = 60_000;
const PEER_STALE_MS = 35_000;
const PRESENCE_INTERVAL_MS = 10_000;
const SEEN_MAX = 8_000;
const RATE_WINDOW_MS = 1_000;
const RATE_MAX_MESSAGES = 600;
const RATE_MAX_CHARS = 12 * 1024 * 1024;

/**
 * A Trystero-compatible room facade backed by multiple independent strategies.
 * Physical Trystero IDs never escape this class; callers see signed logical IDs.
 */
export class MultipathRoom {
  /**
   * @param {{
   *   strategies: { name: string, joinRoom: Function }[],
   *   config: object,
   *   roomId: string,
   *   callbacks?: object,
   *   identity: import("./identity.js").SessionIdentity,
   * }} opts
   */
  constructor(opts) {
    this.identity = opts.identity;
    this.selfId = opts.identity.peerId;
    this.roomId = opts.roomId;
    this.callbacks = opts.callbacks || {};
    /** @type {Map<string, { name: string, room: object, action: object }>} */
    this._strategies = new Map();
    /** @type {Map<string, { key: string, strategy: string, physicalId: string, logicalId?: string, pc?: RTCPeerConnection }>} */
    this._paths = new Map();
    /** @type {Map<string, { publicJwk?: JsonWebKey, lastSeen: number, directPaths: Set<string> }>} */
    this._logicalPeers = new Map();
    /** @type {Map<string, object>} */
    this._actions = new Map();
    this._seen = new Map();
    this._verifying = new Set();
    this._rate = new Map();
    this._inboundQueues = new Map();
    this._sendQueue = Promise.resolve();
    this._closed = false;
    this._onPeerJoin = null;
    this._onPeerLeave = null;
    this._onPathChange = null;

    for (const strategy of opts.strategies) {
      this._joinStrategy(strategy, opts.config);
    }

    this._presenceTimer = setInterval(
      () => this._sendPresence(),
      PRESENCE_INTERVAL_MS,
    );
    this._pruneTimer = setInterval(() => this._prune(), 5_000);
    setTimeout(() => this._sendPresence(), 250);
  }

  set onPeerJoin(fn) {
    this._onPeerJoin = typeof fn === "function" ? fn : null;
    if (this._onPeerJoin) {
      for (const peerId of this._logicalPeers.keys()) {
        queueMicrotask(() => this._onPeerJoin?.(peerId));
      }
    }
  }

  get onPeerJoin() {
    return this._onPeerJoin;
  }

  set onPeerLeave(fn) {
    this._onPeerLeave = typeof fn === "function" ? fn : null;
  }

  get onPeerLeave() {
    return this._onPeerLeave;
  }

  set onPathChange(fn) {
    this._onPathChange = typeof fn === "function" ? fn : null;
  }

  get onPathChange() {
    return this._onPathChange;
  }

  /** @param {string} name */
  makeAction(name) {
    if (this._actions.has(name)) return this._actions.get(name);
    const facade = {
      onMessage: null,
      send: (data, opts = {}) =>
        this._enqueueSend(name, data, opts.target || BROADCAST),
    };
    this._actions.set(name, facade);
    return facade;
  }

  getPeers() {
    const peers = {};
    for (const path of this._paths.values()) {
      if (path.pc) peers[path.key] = path.pc;
    }
    return peers;
  }

  getPathSummary() {
    let mqtt = 0;
    let nostr = 0;
    for (const path of this._paths.values()) {
      if (!path.logicalId) continue;
      if (path.strategy === "mqtt") mqtt += 1;
      if (path.strategy === "nostr") nostr += 1;
    }
    const indirect = [...this._logicalPeers.values()].filter(
      (p) => p.directPaths.size === 0,
    ).length;
    return { mqtt, nostr, indirect };
  }

  /**
   * Aggregate logical reachability across direct MQTT/Nostr paths and recently
   * observed relayed packets.
   * @param {string} logicalId
   */
  isPeerReachable(logicalId) {
    const peer = this._logicalPeers.get(logicalId);
    return Boolean(
      peer &&
        (peer.directPaths.size > 0 ||
          Date.now() - peer.lastSeen <= PEER_STALE_MS),
    );
  }

  leave() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._presenceTimer);
    clearInterval(this._pruneTimer);
    for (const entry of this._strategies.values()) {
      try {
        entry.room.leave?.();
      } catch {
        // Best-effort shutdown.
      }
    }
    this._strategies.clear();
    this._paths.clear();
    this._logicalPeers.clear();
  }

  _joinStrategy(strategy, config) {
    try {
      const room = strategy.joinRoom(config, this.roomId, {
        onJoinError: (details) => {
          warn("mux", `${strategy.name} join failed`, details?.error || details);
        },
      });
      const action = room.makeAction(INTERNAL_ACTION);
      const entry = { name: strategy.name, room, action };
      this._strategies.set(strategy.name, entry);

      action.onMessage = (wire, { peerId }) => {
        const key = `${strategy.name}:${peerId}`;
        const previous = this._inboundQueues.get(key) || Promise.resolve();
        const next = previous
          .then(() => this._onWire(wire, strategy.name, peerId))
          .catch((error) => warn("mux", "wire rejected", error));
        this._inboundQueues.set(key, next);
      };

      room.onPeerJoin = (physicalId) => {
        const key = `${strategy.name}:${physicalId}`;
        const pc = room.getPeers?.()?.[physicalId];
        this._paths.set(key, {
          key,
          strategy: strategy.name,
          physicalId,
          pc,
        });
        log("mux", "physical join", key);
        this._sendIdentity(strategy.name, physicalId);
      };

      room.onPeerLeave = (physicalId) => {
        const key = `${strategy.name}:${physicalId}`;
        const path = this._paths.get(key);
        this._paths.delete(key);
        if (path?.logicalId) {
          const peer = this._logicalPeers.get(path.logicalId);
          peer?.directPaths.delete(key);
        }
        log("mux", "physical leave", key);
        this._onPathChange?.();
      };
    } catch (error) {
      warn("mux", `${strategy.name} setup failed`, error);
    }
  }

  async _sendIdentity(strategyName, physicalId) {
    const entry = this._strategies.get(strategyName);
    if (!entry || this._closed) return;
    const core = {
      kind: "identity",
      peerId: this.selfId,
      publicJwk: this.identity.publicJwk,
      issuedAt: Date.now(),
      nonce: randomId(),
    };
    const signature = await this.identity.sign(core);
    await entry.action
      .send(
        { kind: "identity", core, signature },
        { target: physicalId },
      )
      .catch((error) => warn("mux", "identity send failed", error));
  }

  async _onWire(wire, strategyName, physicalId) {
    if (this._closed || !wire || typeof wire !== "object") return;
    const key = `${strategyName}:${physicalId}`;
    if (!this._allowIngress(key, wire)) return;
    if (wire.kind === "identity") {
      await this._onIdentity(wire, key);
      return;
    }
    if (wire.kind === "packet") {
      await this._onPacket(wire, key);
    }
  }

  async _onIdentity(wire, pathKey) {
    const core = wire.core;
    if (
      !core ||
      core.kind !== "identity" ||
      Math.abs(Date.now() - Number(core.issuedAt)) > PACKET_MAX_AGE_MS ||
      !(await verifySignedValue(
        core.peerId,
        core.publicJwk,
        core,
        wire.signature,
      ))
    ) {
      return;
    }
    const wasUnbound = !this._paths.get(pathKey)?.logicalId;
    this._bindPath(pathKey, core.peerId, core.publicJwk);
    if (wasUnbound) {
      const path = this._paths.get(pathKey);
      if (path) this._sendIdentity(path.strategy, path.physicalId);
    }
  }

  _bindPath(pathKey, logicalId, publicJwk) {
    if (!logicalId || logicalId === this.selfId) return;
    const path = this._paths.get(pathKey);
    if (!path) return;
    if (path.logicalId && path.logicalId !== logicalId) {
      this._logicalPeers.get(path.logicalId)?.directPaths.delete(pathKey);
    }
    path.logicalId = logicalId;
    let peer = this._logicalPeers.get(logicalId);
    const isNew = !peer;
    if (!peer) {
      peer = { publicJwk, lastSeen: Date.now(), directPaths: new Set() };
      this._logicalPeers.set(logicalId, peer);
    }
    const isNewPath = !peer.directPaths.has(pathKey);
    peer.publicJwk = publicJwk || peer.publicJwk;
    peer.lastSeen = Date.now();
    peer.directPaths.add(pathKey);
    if (isNew || isNewPath) this._onPeerJoin?.(logicalId);
    this._onPathChange?.();
  }

  _markReachable(logicalId, publicJwk) {
    if (!logicalId || logicalId === this.selfId) return;
    let peer = this._logicalPeers.get(logicalId);
    const isNew = !peer;
    if (!peer) {
      peer = { publicJwk, lastSeen: Date.now(), directPaths: new Set() };
      this._logicalPeers.set(logicalId, peer);
    }
    peer.publicJwk = publicJwk || peer.publicJwk;
    peer.lastSeen = Date.now();
    if (isNew) this._onPeerJoin?.(logicalId);
    if (isNew) this._onPathChange?.();
  }

  _enqueueSend(actionName, data, destination) {
    const operation = this._sendQueue.then(() =>
      this._createAndTransmit(actionName, data, destination),
    );
    this._sendQueue = operation.catch(() => {});
    return operation;
  }

  async _createAndTransmit(actionName, data, destination) {
    if (this._closed) throw new Error("Multipath room is closed");
    const core = {
      kind: "packet",
      packetId: randomId(),
      source: this.selfId,
      destination: destination || BROADCAST,
      createdAt: Date.now(),
      maxHops: MAX_HOPS,
      actionName,
      data,
      publicJwk: this.identity.publicJwk,
    };
    const serializedLength = JSON.stringify(core).length;
    if (serializedLength > MAX_PACKET_CHARS) {
      throw new Error("Packet exceeds relay size limit");
    }
    const signature = await this.identity.sign(core);
    const packet = {
      kind: "packet",
      core,
      signature,
      route: { hops: [this.selfId] },
    };
    this._remember(core.packetId);
    await this._transmit(packet, null);
  }

  async _onPacket(packet, ingressKey) {
    const core = packet.core;
    const route = packet.route;
    if (
      !core ||
      core.kind !== "packet" ||
      !core.packetId ||
      !core.source ||
      !core.destination ||
      !Array.isArray(route?.hops) ||
      this._seen.has(core.packetId) ||
      this._verifying.has(core.packetId) ||
      Math.abs(Date.now() - Number(core.createdAt)) > PACKET_MAX_AGE_MS ||
      JSON.stringify(core).length > MAX_PACKET_CHARS ||
      route.hops.includes(this.selfId) ||
      route.hops.length > Math.min(Number(core.maxHops) || 0, MAX_HOPS)
    ) {
      return;
    }

    this._verifying.add(core.packetId);
    const verified = await verifySignedValue(
      core.source,
      core.publicJwk,
      core,
      packet.signature,
    );
    this._verifying.delete(core.packetId);
    if (!verified || this._seen.has(core.packetId)) return;

    this._remember(core.packetId);
    const ingress = this._paths.get(ingressKey);
    if (route.hops.length === 1 && ingress && core.source !== this.selfId) {
      this._bindPath(ingressKey, core.source, core.publicJwk);
    }

    const forSelf =
      core.destination === this.selfId || core.destination === BROADCAST;
    if (forSelf) {
      this._markReachable(core.source, core.publicJwk);
      this._deliver(core);
    }

    const shouldRelay =
      core.destination === BROADCAST || core.destination !== this.selfId;
    if (shouldRelay && route.hops.length < Math.min(core.maxHops, MAX_HOPS)) {
      const forwarded = {
        ...packet,
        route: { hops: [...route.hops, this.selfId] },
      };
      await this._transmit(forwarded, ingressKey);
    }
  }

  _deliver(core) {
    if (core.actionName === "__presence") return;
    const action = this._actions.get(core.actionName);
    if (typeof action?.onMessage !== "function") return;
    try {
      action.onMessage(core.data, {
        peerId: core.source,
        relayed: core.destination !== BROADCAST && !this._hasDirect(core.source),
        hops: undefined,
      });
    } catch (error) {
      warn("mux", "application receive failed", error);
    }
  }

  async _transmit(packet, ingressKey) {
    const destination = packet.core.destination;
    const direct =
      destination === BROADCAST ? [] : this._directPaths(destination);
    if (direct.length) {
      await this._sendOverPaths(packet, direct, ingressKey, true);
      return;
    }
    const neighbors = this._neighborPaths(ingressKey);
    await this._sendOverPaths(packet, neighbors, ingressKey, false);
  }

  async _sendOverPaths(packet, paths, ingressKey, directDestination) {
    const available = paths.filter((path) => path.key !== ingressKey);
    if (!available.length) return;
    const isChunk = packet.core.data?.type === "media-chunk";
    if (isChunk) {
      if (directDestination) {
        await this._sendFirstAvailable(packet, available);
        return;
      }
      /** @type {Map<string, object[]>} */
      const branches = new Map();
      for (const path of available) {
        const branch = path.logicalId || path.key;
        if (!branches.has(branch)) branches.set(branch, []);
        branches.get(branch).push(path);
      }
      await Promise.all(
        [...branches.values()].map((branchPaths) =>
          this._sendFirstAvailable(packet, branchPaths),
        ),
      );
      return;
    }

    const sends = available.map((path) =>
      this._sendPath(packet, path).catch((error) => {
        warn("mux", `send via ${path.strategy} failed`, error);
      }),
    );
    await Promise.all(sends);
  }

  async _sendFirstAvailable(packet, paths) {
    let lastError;
    for (const path of paths) {
      try {
        await this._sendPath(packet, path);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) warn("mux", "all media paths failed", lastError);
  }

  _sendPath(packet, path) {
    const entry = this._strategies.get(path.strategy);
    if (!entry) return Promise.reject(new Error("Strategy unavailable"));
    return Promise.resolve(
      entry.action.send(packet, { target: path.physicalId }),
    );
  }

  _directPaths(logicalId) {
    const peer = this._logicalPeers.get(logicalId);
    if (!peer) return [];
    return [...peer.directPaths]
      .map((key) => this._paths.get(key))
      .filter(Boolean)
      .sort((a, b) => pathRank(a.strategy) - pathRank(b.strategy));
  }

  _neighborPaths(ingressKey) {
    return [...this._paths.values()]
      .filter((path) => path.key !== ingressKey && path.logicalId)
      .sort((a, b) => pathRank(a.strategy) - pathRank(b.strategy));
  }

  _hasDirect(logicalId) {
    return this._directPaths(logicalId).length > 0;
  }

  _sendPresence() {
    if (this._closed) return;
    // Presence must not sit behind a long media-signing queue.
    this._createAndTransmit(
      "__presence",
      { at: Date.now() },
      BROADCAST,
    ).catch(() => {});
  }

  _prune() {
    const now = Date.now();
    for (const [id, peer] of this._logicalPeers) {
      if (peer.directPaths.size || now - peer.lastSeen <= PEER_STALE_MS) continue;
      this._logicalPeers.delete(id);
      this._onPeerLeave?.(id);
      this._onPathChange?.();
    }
    for (const [id, seenAt] of this._seen) {
      if (now - seenAt > PACKET_MAX_AGE_MS) this._seen.delete(id);
    }
  }

  _remember(packetId) {
    this._seen.set(packetId, Date.now());
    while (this._seen.size > SEEN_MAX) {
      this._seen.delete(this._seen.keys().next().value);
    }
  }

  _allowIngress(pathKey, wire) {
    const now = Date.now();
    const chars = approximateChars(wire);
    let rate = this._rate.get(pathKey);
    if (!rate || now - rate.startedAt >= RATE_WINDOW_MS) {
      rate = { startedAt: now, messages: 0, chars: 0 };
      this._rate.set(pathKey, rate);
    }
    rate.messages += 1;
    rate.chars += chars;
    return (
      chars <= MAX_PACKET_CHARS &&
      rate.messages <= RATE_MAX_MESSAGES &&
      rate.chars <= RATE_MAX_CHARS
    );
  }
}

function pathRank(strategy) {
  return strategy === "nostr" ? 0 : strategy === "mqtt" ? 1 : 2;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function approximateChars(value) {
  try {
    return JSON.stringify(value).length;
  } catch {
    return MAX_PACKET_CHARS + 1;
  }
}
