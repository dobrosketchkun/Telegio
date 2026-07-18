import { APP_ID, APP_VERSION } from "./constants.js";
import {
  addRosterPeer,
  appendSystemToGroups,
  applyDm,
  applyHost,
  applyHostEvent,
  createEmptyDmState,
  createHostState,
  fanoutPeerIdsForGroup,
  filterHostStateForPeer,
  getHostPeerId,
  removeRosterPeer,
} from "./engine.js";
import { makeSessionId, dmIdFor } from "./ids.js";
import { mintInviteUrl } from "./invite.js";
import { decodeFrame, encodeFrame } from "./protocol.js";
import { loadTrystero, roomConfig } from "./trystero.js";

/**
 * @typedef {{
 *   onChange: () => void,
 *   onStatus: (status: string) => void,
 *   onError: (message: string) => void,
 * }} SessionHooks
 */

/**
 * Online session controller (host or guest).
 */
export class ChatSession {
  /**
   * @param {SessionHooks} hooks
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** @type {"host" | "guest" | null} */
    this.role = null;
    /** @type {string} */
    this.selfPeerId = "";
    /** @type {import("./engine.js").HostState | null} */
    this.hostState = null;
    /** @type {import("./engine.js").DmState} */
    this.dmState = createEmptyDmState();
    /** @type {string | null} */
    this.inviteUrl = null;
    /** @type {boolean} */
    this.ended = false;
    /** @type {Set<string>} */
    this.connectedPeers = new Set();
    this._room = null;
    this._chat = null;
    this._awaitingHello = new Set();
    /** @type {ReturnType<typeof setInterval> | null} */
    this._helloRetry = null;
    /** @type {string} */
    this._pendingDisplayName = "";
  }

  get roster() {
    return this.hostState?.roster || [];
  }

  get sessionEnded() {
    return this.ended || Boolean(this.hostState?.session?.ended);
  }

  /**
   * @param {{ displayName: string, title?: string }} opts
   */
  async createHost(opts) {
    const displayName = String(opts.displayName || "").trim() || "Host";
    const title = String(opts.title || "").trim() || "Session";
    this.hooks.onStatus("Connecting…");

    const { joinRoom, selfId } = await loadTrystero();
    this.selfPeerId = selfId;
    this.role = "host";

    const sessionId = makeSessionId();
    this.hostState = createHostState({
      sessionId,
      title,
      hostPeer: {
        peerId: selfId,
        displayName,
        role: "host",
        joinedAt: Date.now(),
        colorIndex: 0,
      },
    });
    this.inviteUrl = mintInviteUrl(sessionId);
    this.dmState = createEmptyDmState();

    await this._joinRoom(joinRoom, sessionId);
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
    return this;
  }

  /**
   * @param {{ displayName: string, sessionId: string }} opts
   */
  async joinGuest(opts) {
    const displayName = String(opts.displayName || "").trim() || "Guest";
    const sessionId = String(opts.sessionId || "").trim();
    if (!sessionId) throw new Error("Missing session id");

    this.hooks.onStatus("Connecting…");
    const { joinRoom, selfId } = await loadTrystero();
    this.selfPeerId = selfId;
    this.role = "guest";
    this.dmState = createEmptyDmState();
    this._pendingDisplayName = displayName;

    await this._joinRoom(joinRoom, sessionId);
    this._sendHello();
    this._startHelloRetry();
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
    return this;
  }

  leave() {
    this._stopHelloRetry();
    if (this.role === "host" && this.hostState && !this.sessionEnded) {
      this._endSessionLocal("Host left");
      try {
        this._send(encodeFrame("session-ended", { reason: "host-left" }));
      } catch {
        /* ignore */
      }
    }
    try {
      this._room?.leave?.();
    } catch {
      /* ignore */
    }
    this._room = null;
    this._chat = null;
  }

  /**
   * @param {object} action
   */
  dispatchHostAction(action) {
    if (!this.hostState || this.sessionEnded) return;
    if (this.role === "host") {
      const result = applyHost(this.hostState, action, {
        actorPeerId: this.selfPeerId,
      });
      if (!result.ok) {
        this.hooks.onError(result.error);
        return;
      }
      this.hostState = result.state;
      this._emitEffects(result.effects, /* skipSelf */ true);
      this._ackFromEffects(result.effects);
      if (this.hostState.session.ended) {
        this.ended = true;
        this._send(encodeFrame("session-ended", { reason: "ended" }));
      }
      this.hooks.onChange();
      return;
    }

    // Guest: send to host, wait for events
    const hostId = getHostPeerId(this.hostState);
    if (!hostId) {
      this.hooks.onError("Host unknown");
      return;
    }
    this._send(encodeFrame("action", { action }), hostId);
  }

  /**
   * Open or focus a DM with another roster peer.
   * @param {string} otherPeerId
   * @returns {string | null} dmId
   */
  openDm(otherPeerId) {
    if (!otherPeerId || otherPeerId === this.selfPeerId) return null;
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-open",
      peerId: otherPeerId,
    });
    if (!r.ok) {
      this.hooks.onError(r.error);
      return null;
    }
    this.dmState = r.state;
    this._send(
      encodeFrame("dm-open", {
        dmId: r.dmId,
        fromPeerId: this.selfPeerId,
      }),
      otherPeerId,
    );
    this.hooks.onChange();
    return r.dmId;
  }

  /**
   * @param {string} dmId
   * @param {string} text
   * @param {{ replyTo?: string, entities?: object[] }} [opts]
   */
  sendDmText(dmId, text, opts = {}) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-send-text",
      dmId,
      text,
      replyTo: opts.replyTo,
      entities: opts.entities,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "DM send failed");
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (!other) {
      this.hooks.onError("DM peer missing");
      return;
    }
    this._send(
      encodeFrame("dm-send-text", {
        dmId,
        message: r.message,
        text: r.message.text,
      }),
      other,
    );
    this.hooks.onChange();
  }

  /**
   * @param {string} chatId
   * @param {string} text
   * @param {{ replyTo?: string, entities?: object[] }} [opts]
   */
  sendGroupText(chatId, text, opts = {}) {
    this.dispatchHostAction({
      type: "send-text",
      chatId,
      text,
      replyTo: opts.replyTo,
      entities: opts.entities,
    });
  }

  /**
   * @param {string} chatId
   * @param {{ pack: string, stickerId: string, replyTo?: string }} sticker
   */
  sendGroupSticker(chatId, sticker) {
    this.dispatchHostAction({
      type: "send-sticker",
      chatId,
      pack: sticker.pack,
      stickerId: sticker.stickerId,
      replyTo: sticker.replyTo,
    });
  }

  /**
   * @param {string} dmId
   * @param {{ pack: string, stickerId: string, replyTo?: string }} sticker
   */
  sendDmSticker(dmId, sticker) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-send-sticker",
      dmId,
      pack: sticker.pack,
      stickerId: sticker.stickerId,
      replyTo: sticker.replyTo,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "Sticker send failed");
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (!other) {
      this.hooks.onError("DM peer missing");
      return;
    }
    this._send(
      encodeFrame("dm-send-sticker", {
        dmId,
        message: r.message,
        pack: sticker.pack,
        stickerId: sticker.stickerId,
      }),
      other,
    );
    this.hooks.onChange();
  }

  /**
   * @param {string} chatId
   * @param {string} messageId
   * @param {string} text
   * @param {object[]} [entities]
   */
  editGroupMessage(chatId, messageId, text, entities) {
    this.dispatchHostAction({
      type: "edit-message",
      chatId,
      messageId,
      text,
      entities,
    });
  }

  /**
   * @param {string} dmId
   * @param {string} messageId
   * @param {string} text
   * @param {object[]} [entities]
   */
  editDmMessage(dmId, messageId, text, entities) {
    const editedAt = Date.now();
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-edit",
      dmId,
      messageId,
      text,
      entities,
      editedAt,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "Edit failed");
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (other) {
      this._send(
        encodeFrame("dm-edit", {
          dmId,
          messageId,
          text,
          entities,
          editedAt,
          message: r.message,
        }),
        other,
      );
    }
    this.hooks.onChange();
  }

  /**
   * @param {string} dmId
   * @param {string} messageId
   */
  deleteDmMessage(dmId, messageId) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-delete",
      dmId,
      messageId,
    });
    if (!r.ok) {
      this.hooks.onError(r.error);
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (other) {
      this._send(encodeFrame("dm-delete", { dmId, messageId }), other);
    }
    this.hooks.onChange();
  }

  /**
   * @param {Function} joinRoom
   * @param {string} sessionId
   */
  async _joinRoom(joinRoom, sessionId) {
    const room = joinRoom(roomConfig(), sessionId, {
      onJoinError: (err) => {
        this.hooks.onError(err?.message || String(err));
        this.hooks.onStatus("Connection failed");
      },
    });
    this._room = room;
    const chat = room.makeAction("chat");
    this._chat = chat;

    chat.onMessage = (data, { peerId }) => {
      this._onFrame(data, peerId);
    };

    room.onPeerJoin = (peerId) => {
      this.connectedPeers.add(peerId);
      if (this.role === "host") {
        this._awaitingHello.add(peerId);
        // Guest hello can race before the data channel is up — nudge them.
        window.setTimeout(() => {
          if (this._awaitingHello.has(peerId)) {
            this._send(encodeFrame("hello-request", {}), peerId);
          }
        }, 800);
      }
      if (this.role === "guest" && !this.hostState) {
        this._sendHello(peerId);
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    room.onPeerLeave = (peerId) => {
      this.connectedPeers.delete(peerId);
      this._awaitingHello.delete(peerId);
      if (this.role === "host" && this.hostState) {
        const leaving = this.hostState.roster.find((r) => r.peerId === peerId);
        const name = leaving?.displayName || peerId;
        const groupIds = Object.values(this.hostState.groups)
          .filter((g) => g.memberPeerIds.includes(peerId))
          .map((g) => g.id);
        this.hostState = removeRosterPeer(this.hostState, peerId);
        if (groupIds.length) {
          const sys = appendSystemToGroups(
            this.hostState,
            `${name} left`,
            groupIds,
          );
          this.hostState = sys.state;
          this._emitEffects(sys.effects, false);
        }
        this._broadcastRoster();
        this.hooks.onChange();
      }
      if (this.role === "guest" && this.hostState) {
        const hostId = getHostPeerId(this.hostState);
        if (peerId === hostId) {
          this._endSessionLocal("Host left");
        }
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    window.addEventListener("beforeunload", () => {
      if (this.role === "host") {
        try {
          this._send(encodeFrame("session-ended", { reason: "host-left" }));
        } catch {
          /* ignore */
        }
      }
    });
  }

  /**
   * @param {unknown} data
   * @param {string} peerId
   */
  _onFrame(data, peerId) {
    let type;
    let body;
    try {
      ({ type, body } = decodeFrame(data));
    } catch (e) {
      console.warn("Bad frame", e);
      return;
    }

    if (this.role === "host") {
      this._onHostFrame(type, body, peerId);
    } else {
      this._onGuestFrame(type, body, peerId);
    }
  }

  /**
   * @param {string} type
   * @param {object} body
   * @param {string} peerId
   */
  _onHostFrame(type, body, peerId) {
    if (!this.hostState) return;

    if (type === "hello") {
      if (body.app !== APP_ID) {
        this._send(
          encodeFrame("error", { message: "App mismatch" }),
          peerId,
        );
        return;
      }
      if (body.version !== APP_VERSION) {
        this._send(
          encodeFrame("error", { message: "Version mismatch" }),
          peerId,
        );
        return;
      }
      const displayName = String(body.displayName || "").trim() || "Guest";
      this._awaitingHello.delete(peerId);
      this.hostState = addRosterPeer(this.hostState, {
        peerId,
        displayName,
      });
      // Announce join in every existing group (session-wide visibility in group threads)
      const allGroupIds = Object.keys(this.hostState.groups);
      if (allGroupIds.length) {
        const sys = appendSystemToGroups(
          this.hostState,
          `${displayName} joined the session`,
          allGroupIds,
        );
        this.hostState = sys.state;
        this._emitEffects(sys.effects, false);
      }
      const filtered = filterHostStateForPeer(this.hostState, peerId);
      this._send(
        encodeFrame("welcome", {
          youAre: peerId,
          session: this.hostState.session,
          roster: this.hostState.roster,
          state: filtered,
        }),
        peerId,
      );
      this._broadcastRoster();
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
      return;
    }

    if (type === "action") {
      const action = body.action;
      const result = applyHost(this.hostState, action, {
        actorPeerId: peerId,
      });
      if (!result.ok) {
        this._send(encodeFrame("error", { message: result.error }), peerId);
        return;
      }
      this.hostState = result.state;
      this._emitEffects(result.effects, false);
      this._ackFromEffects(result.effects);
      if (this.hostState.session.ended) {
        this.ended = true;
        this._send(encodeFrame("session-ended", { reason: "ended" }));
      }
      this.hooks.onChange();
      return;
    }

    if (
      type === "dm-open" ||
      type === "dm-send-text" ||
      type === "dm-send-sticker" ||
      type === "dm-edit" ||
      type === "dm-ack" ||
      type === "dm-delete"
    ) {
      this._onDmFrame(type, body, peerId);
    }
  }

  /**
   * @param {string} type
   * @param {object} body
   * @param {string} peerId
   */
  _onGuestFrame(type, body, peerId) {
    if (type === "hello-request") {
      if (!this.hostState) this._sendHello(peerId);
      return;
    }

    if (type === "welcome") {
      const state = body.state;
      if (!state || typeof state !== "object") return;
      this.hostState = state;
      // Ensure roster from welcome body if fuller
      if (Array.isArray(body.roster)) {
        this.hostState = { ...this.hostState, roster: body.roster };
      }
      this._stopHelloRetry();
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
      return;
    }

    if (type === "roster") {
      if (!this.hostState || !Array.isArray(body.roster)) return;
      this.hostState = { ...this.hostState, roster: body.roster };
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
      return;
    }

    if (type === "event") {
      if (!this.hostState) return;
      this.hostState = applyHostEvent(this.hostState, body);
      if (body.event === "message-added" && body.message) {
        this._ackGroupMessage(body.chatId || body.message.chatId, body.message);
      }
      this.hooks.onChange();
      return;
    }

    if (type === "state") {
      if (body.state) {
        this.hostState = body.state;
        this.hooks.onChange();
      }
      return;
    }

    if (type === "error") {
      this._stopHelloRetry();
      this.hooks.onError(body.message || "Error");
      return;
    }

    if (type === "session-ended") {
      this._stopHelloRetry();
      this._endSessionLocal(body.reason || "Session ended");
      return;
    }

    if (
      type === "dm-open" ||
      type === "dm-send-text" ||
      type === "dm-send-sticker" ||
      type === "dm-edit" ||
      type === "dm-ack" ||
      type === "dm-delete"
    ) {
      this._onDmFrame(type, body, peerId);
    }
  }

  /**
   * @param {string} type
   * @param {object} body
   * @param {string} peerId
   */
  _onDmFrame(type, body, peerId) {
    const expected = dmIdFor(this.selfPeerId, peerId);
    const dmId = body.dmId || body.chatId || expected;
    if (dmId !== expected) {
      console.warn("Ignoring DM for unrelated pair", dmId);
      return;
    }

    if (type === "dm-open") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        { type: "dm-open", peerId },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-send-text") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-send-text",
          dmId,
          message: body.message,
          text: body.text,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        if (body.message?.id || r.message?.id) {
          const id = body.message?.id || r.message.id;
          this._send(
            encodeFrame("dm-ack", { dmId, messageIds: [id] }),
            peerId,
          );
        }
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-send-sticker") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-send-sticker",
          dmId,
          message: body.message,
          pack: body.pack || body.message?.sticker?.pack,
          stickerId: body.stickerId || body.message?.sticker?.stickerId,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        if (body.message?.id || r.message?.id) {
          const id = body.message?.id || r.message.id;
          this._send(
            encodeFrame("dm-ack", { dmId, messageIds: [id] }),
            peerId,
          );
        }
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-edit") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-edit",
          dmId,
          messageId: body.messageId || body.message?.id,
          text: body.text || body.message?.text,
          entities: body.entities || body.message?.entities,
          editedAt: body.editedAt || body.message?.editedAt,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-ack") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-ack",
          dmId,
          messageIds: body.messageIds,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-delete") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-delete",
          dmId,
          messageId: body.messageId,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        this.hooks.onChange();
      }
    }
  }

  /** @param {string} dmId */
  _dmOther(dmId) {
    return this.dmState.dms[dmId]?.memberPeerIds.find(
      (p) => p !== this.selfPeerId,
    );
  }

  /**
   * After host applies effects locally, ack messages where we are a non-sender member.
   * @param {import("./engine.js").Effect[]} effects
   */
  _ackFromEffects(effects) {
    for (const effect of effects) {
      if (effect.event === "message-added" && effect.message) {
        this._ackGroupMessage(
          effect.chatId || effect.message.chatId,
          effect.message,
        );
      }
    }
  }

  /**
   * @param {string} chatId
   * @param {import("./engine.js").Message} message
   */
  _ackGroupMessage(chatId, message) {
    if (!this.hostState || !chatId || !message?.id) return;
    if (message.kind === "system") return;
    if (message.senderPeerId === this.selfPeerId) return;
    const chat = this.hostState.groups[chatId];
    if (!chat?.memberPeerIds.includes(this.selfPeerId)) return;

    if (this.role === "host") {
      const result = applyHost(
        this.hostState,
        { type: "ack-delivery", chatId, messageIds: [message.id] },
        { actorPeerId: this.selfPeerId },
      );
      if (result.ok && result.effects.length) {
        this.hostState = result.state;
        this._emitEffects(result.effects, false);
      }
      return;
    }

    const hostId = getHostPeerId(this.hostState);
    if (!hostId) return;
    this._send(
      encodeFrame("action", {
        action: {
          type: "ack-delivery",
          chatId,
          messageIds: [message.id],
        },
      }),
      hostId,
    );
  }

  /**
   * @param {import("./engine.js").Effect[]} effects
   * @param {boolean} skipBroadcastToSelf
   */
  _emitEffects(effects, _skipBroadcastToSelf) {
    if (!this.hostState) return;
    const hostId = getHostPeerId(this.hostState);
    for (const effect of effects) {
      if (effect.event === "session-ended") continue;

      let targets = [];
      if (effect.event === "chat-deleted" && effect.memberPeerIds) {
        targets = [...effect.memberPeerIds];
      } else if (effect.event === "chat-created" && effect.chat) {
        targets = [...effect.chat.memberPeerIds];
      } else if (effect.chatId && this.hostState.groups[effect.chatId]) {
        targets = fanoutPeerIdsForGroup(this.hostState, effect.chatId);
      } else {
        targets = [...this.connectedPeers];
      }
      if (hostId) targets.push(hostId);

      const wireTargets = [...new Set(targets)].filter(
        (id) => id && id !== this.selfPeerId,
      );
      this._sendToPeers(encodeFrame("event", effect), wireTargets);
    }
  }

  _broadcastRoster() {
    if (!this.hostState) return;
    this._send(encodeFrame("roster", { roster: this.hostState.roster }));
  }

  /**
   * @param {object} frame
   * @param {string} [peerId]
   */
  /**
   * @param {string} [targetPeerId]
   */
  _sendHello(targetPeerId) {
    const displayName = this._pendingDisplayName || "Guest";
    this._send(
      encodeFrame("hello", {
        app: APP_ID,
        version: APP_VERSION,
        displayName,
      }),
      targetPeerId,
    );
  }

  _startHelloRetry() {
    this._stopHelloRetry();
    this._helloRetry = setInterval(() => {
      if (this.hostState || this.ended || this.role !== "guest") {
        this._stopHelloRetry();
        return;
      }
      if (this.connectedPeers.size) this._sendHello();
      this.hooks.onStatus(this._statusLabel());
    }, 2500);
  }

  _stopHelloRetry() {
    if (this._helloRetry != null) {
      clearInterval(this._helloRetry);
      this._helloRetry = null;
    }
  }

  _send(frame, peerId) {
    if (!this._chat) return;
    if (peerId) this._chat.send(frame, { target: peerId });
    else this._chat.send(frame);
  }

  /**
   * @param {object} frame
   * @param {string[]} peerIds
   */
  _sendToPeers(frame, peerIds) {
    for (const id of new Set(peerIds)) {
      if (!id || id === this.selfPeerId) continue;
      this._send(frame, id);
    }
  }

  /** @param {string} reason */
  _endSessionLocal(reason) {
    this.ended = true;
    if (this.hostState) {
      this.hostState = {
        ...this.hostState,
        session: { ...this.hostState.session, ended: true },
      };
    }
    this.hooks.onStatus(reason === "host-left" ? "Host left" : "Session ended");
    this.hooks.onChange();
  }

  _statusLabel() {
    if (this.sessionEnded) return "Session ended";
    if (this.role === "guest" && !this.hostState) {
      if (this.connectedPeers.size === 0) {
        return "Looking for host… (VPN often blocks P2P — try without VPN)";
      }
      return "Peer linked · waiting for welcome…";
    }
    const n = this.hostState?.roster?.length || 1;
    if (this.role === "host" && n <= 1 && this.connectedPeers.size === 0) {
      return "Online · waiting for guests";
    }
    return `Connected (${n})`;
  }
}
