import { APP_ID, APP_VERSION } from "./constants.js";
import {
  addRosterPeer,
  applyDm,
  applyHost,
  applyHostEvent,
  createEmptyDmState,
  createHostState,
  fanoutPeerIdsForGroup,
  filterHostStateForPeer,
  getHostPeerId,
  hostSnapshot,
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
    this._send(
      encodeFrame("hello", {
        app: APP_ID,
        version: APP_VERSION,
        displayName,
      }),
    );
    this.hooks.onStatus("Waiting for host…");
    this.hooks.onChange();
    return this;
  }

  leave() {
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
   */
  sendDmText(dmId, text) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-send-text",
      dmId,
      text,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "DM send failed");
      return;
    }
    this.dmState = r.state;
    const other = this.dmState.dms[dmId]?.memberPeerIds.find(
      (p) => p !== this.selfPeerId,
    );
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

  /** @param {string} chatId @param {string} text */
  sendGroupText(chatId, text) {
    this.dispatchHostAction({ type: "send-text", chatId, text });
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
      }
      if (this.role === "guest" && this.hostState) {
        // re-hello if we reconnect somehow
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    room.onPeerLeave = (peerId) => {
      this.connectedPeers.delete(peerId);
      this._awaitingHello.delete(peerId);
      if (this.role === "host" && this.hostState) {
        this.hostState = removeRosterPeer(this.hostState, peerId);
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
      if (this.hostState.session.ended) {
        this.ended = true;
        this._send(encodeFrame("session-ended", { reason: "ended" }));
      }
      this.hooks.onChange();
      return;
    }

    // Host may also receive DMs if they are a participant
    if (type === "dm-open" || type === "dm-send-text") {
      this._onDmFrame(type, body, peerId);
    }
  }

  /**
   * @param {string} type
   * @param {object} body
   * @param {string} peerId
   */
  _onGuestFrame(type, body, peerId) {
    if (type === "welcome") {
      const state = body.state;
      if (!state || typeof state !== "object") return;
      this.hostState = state;
      // Ensure roster from welcome body if fuller
      if (Array.isArray(body.roster)) {
        this.hostState = { ...this.hostState, roster: body.roster };
      }
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
      this.hooks.onError(body.message || "Error");
      return;
    }

    if (type === "session-ended") {
      this._endSessionLocal(body.reason || "Session ended");
      return;
    }

    if (type === "dm-open" || type === "dm-send-text") {
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
        this.hooks.onChange();
      }
    }
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
    if (!this.hostState && this.role === "guest") return "Waiting for host…";
    const n = this.hostState?.roster?.length || 1;
    return `Connected (${n})`;
  }
}
