import {
  APP_ID,
  APP_VERSION,
  HOST_MEDIA_BUDGET_BYTES,
  MAX_ALBUM_ITEMS,
  MEDIA_TURN_HINT,
  VIDEO_AUTO_DOWNLOAD_BYTES,
} from "./constants.js";
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
import { error as logError, log, warn } from "./log.js";
import {
  blobFromBase64Chunks,
  blobToBase64Chunks,
  compressImage,
  mintMediaId,
  prepareVideo,
} from "./media.js";
import { decodeFrame, encodeFrame } from "./protocol.js";
import { loadTrystero, roomConfig } from "./trystero.js";

/**
 * @typedef {{
 *   mime: string,
 *   size: number,
 *   width?: number,
 *   height?: number,
 *   duration?: number,
 *   blob: Blob,
 *   senderPeerId: string,
 *   chatId?: string,
 *   dmId?: string,
 *   objectUrl?: string,
 * }} MediaEntry
 */

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
    /** @type {ReturnType<typeof setInterval> | null} */
    this._diagTimer = null;
    /** @type {string} */
    this._pendingDisplayName = "";
    /** @type {string} */
    this._sessionId = "";
    /** @type {Map<string, MediaEntry>} host group media store */
    this.mediaStore = new Map();
    /** @type {Map<string, MediaEntry>} blobs this peer can render */
    this.localMedia = new Map();
    /** @type {number} */
    this.hostMediaBytes = 0;
    /** @type {Map<string, { meta: object, chunks: string[], from: string }>} */
    this._incoming = new Map();
    /** @type {Map<string, { resolve: (v: boolean) => void, reject: (e: Error) => void }>} */
    this._uploadWaiters = new Map();
    /** @type {Set<string>} */
    this._fetching = new Set();
    /** @type {Map<string, { size: number, mime?: string, duration?: number }>} */
    this._mediaMeta = new Map();
  }

  /**
   * @param {string} mediaId
   * @returns {string | null} object URL
   */
  getMediaUrl(mediaId) {
    const entry = this.localMedia.get(mediaId) || this.mediaStore.get(mediaId);
    if (!entry?.blob) return null;
    if (!entry.objectUrl) {
      entry.objectUrl = URL.createObjectURL(entry.blob);
      this.localMedia.set(mediaId, entry);
    }
    return entry.objectUrl;
  }

  /** @param {string} mediaId @returns {MediaEntry | undefined} */
  getMediaEntry(mediaId) {
    return this.localMedia.get(mediaId) || this.mediaStore.get(mediaId);
  }

  /**
   * @param {string} mediaId
   * @param {MediaEntry} entry
   */
  putLocalMedia(mediaId, entry) {
    const prev = this.localMedia.get(mediaId);
    if (prev?.objectUrl) URL.revokeObjectURL(prev.objectUrl);
    this.localMedia.set(mediaId, { ...entry, objectUrl: undefined });
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
    log("host", "trystero loaded", { selfId });

    const sessionId = makeSessionId();
    this._sessionId = sessionId;
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
    log("host", "session minted", { sessionId, title, inviteUrl: this.inviteUrl });

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
    this._sessionId = sessionId;
    log("guest", "joining", { selfId, sessionId, displayName });

    await this._joinRoom(joinRoom, sessionId);
    this._sendHello();
    this._startHelloRetry();
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
    return this;
  }

  leave() {
    this._stopHelloRetry();
    this._stopDiag();
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
   * Compress/prepare + upload images or one video to host store (or local if host).
   * @param {Blob[]} files
   * @param {{ chatId?: string, onProgress?: (label: string) => void }} [opts]
   * @returns {Promise<{ mediaIds: string[], mediaKind?: "video", mediaInfo?: object[] }>}
   */
  async uploadGroupMedia(files, opts = {}) {
    const batch = classifyMediaBatch(files);
    const hostId = this.hostState ? getHostPeerId(this.hostState) : null;
    if (!hostId) throw new Error("No host");

    /** @type {string[]} */
    const mediaIds = [];
    /** @type {object[]} */
    const mediaInfo = [];
    let i = 0;
    for (const file of batch.files) {
      i += 1;
      const prepared = await this._prepareFile(file, batch.mediaKind, (label) =>
        opts.onProgress?.(
          `${label} ${i}/${batch.files.length}…`.replace(/\s+/g, " "),
        ),
      );
      const mediaId = mintMediaId();
      const entry = {
        mime: prepared.mime,
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
        duration: prepared.duration,
        blob: prepared.blob,
        senderPeerId: this.selfPeerId,
        chatId: opts.chatId,
      };

      if (this.role === "host") {
        const ok = this._hostAcceptMedia(mediaId, entry);
        if (!ok) throw new Error("Host media budget exceeded");
      } else {
        opts.onProgress?.(`Uploading ${i}/${batch.files.length}…`);
        await this._transferMediaTo(hostId, mediaId, entry, {
          chatId: opts.chatId,
        });
        this.putLocalMedia(mediaId, entry);
      }
      mediaIds.push(mediaId);
      mediaInfo.push({
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        width: prepared.width,
        height: prepared.height,
      });
    }
    return {
      mediaIds,
      mediaInfo,
      mediaKind: batch.mediaKind === "video" ? "video" : undefined,
    };
  }

  /**
   * @param {string} chatId
   * @param {{ mediaIds: string[], text?: string, entities?: object[], replyTo?: string, mediaKind?: string, mediaInfo?: object[] }} media
   */
  sendGroupMedia(chatId, media) {
    this.dispatchHostAction({
      type: "send-media",
      chatId,
      mediaIds: media.mediaIds,
      mediaInfo: media.mediaInfo,
      text: media.text,
      entities: media.entities,
      replyTo: media.replyTo,
      mediaKind: media.mediaKind,
    });
  }

  /**
   * Compress/prepare, P2P transfer to DM peer, then dm-send-media.
   * @param {string} dmId
   * @param {Blob[]} files
   * @param {{ text?: string, entities?: object[], replyTo?: string, onProgress?: (label: string) => void }} [opts]
   */
  async sendDmMedia(dmId, files, opts = {}) {
    const batch = classifyMediaBatch(files);
    const other = this._dmOther(dmId);
    if (!other) throw new Error("DM peer missing");

    /** @type {string[]} */
    const mediaIds = [];
    /** @type {object[]} */
    const mediaInfo = [];
    let i = 0;
    for (const file of batch.files) {
      i += 1;
      const prepared = await this._prepareFile(file, batch.mediaKind, (label) =>
        opts.onProgress?.(
          `${label} ${i}/${batch.files.length}…`.replace(/\s+/g, " "),
        ),
      );
      const mediaId = mintMediaId();
      const entry = {
        mime: prepared.mime,
        size: prepared.size,
        width: prepared.width,
        height: prepared.height,
        duration: prepared.duration,
        blob: prepared.blob,
        senderPeerId: this.selfPeerId,
        dmId,
      };
      this.putLocalMedia(mediaId, entry);
      opts.onProgress?.(`Sending ${i}/${batch.files.length}…`);
      await this._transferMediaTo(other, mediaId, entry, { dmId });
      mediaIds.push(mediaId);
      mediaInfo.push({
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        width: prepared.width,
        height: prepared.height,
      });
    }

    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-send-media",
      dmId,
      mediaIds,
      mediaInfo,
      text: opts.text,
      entities: opts.entities,
      replyTo: opts.replyTo,
      mediaKind: batch.mediaKind === "video" ? "video" : undefined,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "Media send failed");
      return;
    }
    this.dmState = r.state;
    this._send(
      encodeFrame("dm-send-media", {
        dmId,
        message: r.message,
        mediaIds,
        mediaInfo,
        text: opts.text,
        mediaKind: batch.mediaKind === "video" ? "video" : undefined,
      }),
      other,
    );
    this.hooks.onChange();
  }

  /**
   * @param {Blob} file
   * @param {"image" | "video"} kind
   * @param {(label: string) => void} [onLabel]
   */
  async _prepareFile(file, kind, onLabel) {
    if (kind === "video") {
      onLabel?.("Preparing video");
      const v = await prepareVideo(file);
      return {
        blob: v.blob,
        mime: v.mime,
        width: v.width,
        height: v.height,
        duration: v.duration,
        size: v.size,
      };
    }
    onLabel?.("Compressing");
    const img = await compressImage(file);
    return {
      blob: img.blob,
      mime: img.mime,
      width: img.width,
      height: img.height,
      size: img.size,
    };
  }

  /**
   * Request any missing media ids (group path).
   * Videos larger than VIDEO_AUTO_DOWNLOAD_BYTES are skipped unless force.
   * @param {string[]} mediaIds
   * @param {{ force?: boolean, sizes?: Record<string, number> }} [opts]
   */
  ensureMedia(mediaIds, opts = {}) {
    if (!this.hostState) return;
    const hostId = getHostPeerId(this.hostState);
    for (const id of mediaIds || []) {
      if (!id || this.localMedia.has(id) || this.mediaStore.has(id)) continue;
      if (this._fetching.has(id)) continue;
      const knownSize =
        opts.sizes?.[id] ??
        this._mediaMeta.get(id)?.size ??
        0;
      if (
        !opts.force &&
        knownSize > VIDEO_AUTO_DOWNLOAD_BYTES
      ) {
        log("media", "skip auto-download (large)", id, knownSize);
        continue;
      }
      this._fetching.add(id);
      if (this.role === "host") {
        const entry = this.mediaStore.get(id);
        if (entry) this.putLocalMedia(id, entry);
        this._fetching.delete(id);
        this.hooks.onChange();
        continue;
      }
      if (!hostId) {
        this._fetching.delete(id);
        continue;
      }
      log("media", "request", id);
      this._send(encodeFrame("media-request", { mediaId: id }), hostId);
    }
  }

  /**
   * Remember size/mime from messages so large-video UI can show before fetch.
   * @param {import("./engine.js").Message} message
   */
  rememberMediaInfo(message) {
    if (!message?.mediaIds?.length) return;
    const infos = message.mediaInfo || [];
    message.mediaIds.forEach((id, i) => {
      const info = infos[i];
      if (!info) return;
      this._mediaMeta.set(id, {
        size: Number(info.size) || 0,
        mime: info.mime,
        duration: info.duration,
      });
    });
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
    const cfg = roomConfig();
    log("room", "joinRoom", {
      sessionId,
      role: this.role,
      appId: cfg.appId,
      iceServers: cfg.rtcConfig?.iceServers?.map((s) => s.urls),
      turnCount: cfg.turnConfig?.length || 0,
    });
    const room = joinRoom(cfg, sessionId, {
      onJoinError: (err) => {
        logError("room", "onJoinError", err);
        this.hooks.onError(err?.message || String(err));
        this.hooks.onStatus("Connection failed");
      },
    });
    this._room = room;
    const chat = room.makeAction("chat");
    this._chat = chat;
    log("room", "joined", {
      selfPeerId: this.selfPeerId,
      peersNow: Object.keys(room.getPeers?.() || {}),
    });

    chat.onMessage = (data, { peerId }) => {
      let type = "?";
      try {
        type = decodeFrame(data).type;
      } catch {
        /* logged in _onFrame */
      }
      log("recv", type, "from", peerId);
      this._onFrame(data, peerId);
    };

    room.onPeerJoin = (peerId) => {
      this.connectedPeers.add(peerId);
      const pc = room.getPeers?.()?.[peerId];
      log("peer", "join", peerId, {
        ice: pc?.iceConnectionState,
        conn: pc?.connectionState,
        peers: [...this.connectedPeers],
      });
      if (this.role === "host") {
        this._awaitingHello.add(peerId);
        // Guest hello can race before the data channel is up — nudge them.
        window.setTimeout(() => {
          if (this._awaitingHello.has(peerId)) {
            log("host", "hello-request →", peerId);
            this._send(encodeFrame("hello-request", {}), peerId);
          }
        }, 800);
      }
      if (this.role === "guest" && !this.hostState) {
        log("guest", "hello → peer join", peerId);
        this._sendHello(peerId);
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    room.onPeerLeave = (peerId) => {
      log("peer", "leave", peerId);
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

    this._startDiag();

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

    if (String(type).startsWith("media-")) {
      this._onMediaFrame(type, body, peerId);
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
      log("host", "hello from", peerId, body);
      if (body.app !== APP_ID) {
        warn("host", "app mismatch", body.app);
        this._send(
          encodeFrame("error", { message: "App mismatch" }),
          peerId,
        );
        return;
      }
      if (body.version !== APP_VERSION) {
        warn("host", "version mismatch", body.version, "expected", APP_VERSION);
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
      log("host", "welcome →", peerId, {
        title: this.hostState.session?.title,
        roster: this.hostState.roster.length,
      });
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
      type === "dm-send-media" ||
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
      log("guest", "hello-request from", peerId);
      if (!this.hostState) this._sendHello(peerId);
      return;
    }

    if (type === "welcome") {
      const state = body.state;
      if (!state || typeof state !== "object") {
        warn("guest", "welcome missing state", body);
        return;
      }
      this.hostState = state;
      // Ensure roster from welcome body if fuller
      if (Array.isArray(body.roster)) {
        this.hostState = { ...this.hostState, roster: body.roster };
      }
      log("guest", "welcome ok", {
        title: this.hostState.session?.title,
        roster: this.hostState.roster?.length,
        from: peerId,
      });
      this._stopHelloRetry();
      this._stopDiag();
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
        this.rememberMediaInfo(body.message);
        if (body.message.mediaIds?.length) {
          const sizes = Object.create(null);
          body.message.mediaIds.forEach((id, i) => {
            const sz = body.message.mediaInfo?.[i]?.size;
            if (sz != null) sizes[id] = sz;
          });
          this.ensureMedia(body.message.mediaIds, { sizes });
        }
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
      type === "dm-send-media" ||
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

    if (type === "dm-send-media") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-send-media",
          dmId,
          message: body.message,
          mediaIds: body.mediaIds || body.message?.mediaIds,
          mediaInfo: body.mediaInfo || body.message?.mediaInfo,
          text: body.text || body.message?.text,
          mediaKind: body.mediaKind,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        if (r.message) this.rememberMediaInfo(r.message);
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
        this.rememberMediaInfo(effect.message);
        if (effect.message.mediaIds?.length) {
          const sizes = Object.create(null);
          effect.message.mediaIds.forEach((id, i) => {
            const sz = effect.message.mediaInfo?.[i]?.size;
            if (sz != null) sizes[id] = sz;
          });
          this.ensureMedia(effect.message.mediaIds, { sizes });
        }
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
   * @param {string} type
   * @param {object} body
   * @param {string} peerId
   */
  _onMediaFrame(type, body, peerId) {
    const mediaId = String(body.mediaId || "").trim();
    if (!mediaId && type !== "media-request") return;

    if (type === "media-offer") {
      if (body.dmId) {
        const expected = dmIdFor(this.selfPeerId, peerId);
        if (body.dmId !== expected) {
          warn("media", "ignore DM offer for other pair", body.dmId);
          return;
        }
      } else if (this.role !== "host") {
        // Guests only accept offers when fetching (host→guest) or DM.
        // Group uploads are host-only; ignore peer→guest group offers.
      }
      log("media", "offer", mediaId, {
        size: body.size,
        from: peerId,
        dm: Boolean(body.dmId),
      });
      this._mediaMeta.set(mediaId, {
        size: Number(body.size) || 0,
        mime: body.mime,
        duration: body.duration != null ? Number(body.duration) : undefined,
      });
      this._incoming.set(mediaId, {
        meta: body,
        chunks: [],
        from: peerId,
      });
      return;
    }

    if (type === "media-chunk") {
      const inc = this._incoming.get(mediaId);
      if (!inc) return;
      const index = Number(body.index) || 0;
      inc.chunks[index] = String(body.data || "");
      return;
    }

    if (type === "media-complete") {
      // Ack from receiver → resolve uploader waiter
      if (typeof body.ok === "boolean") {
        const waiter = this._uploadWaiters.get(mediaId);
        if (waiter) {
          this._uploadWaiters.delete(mediaId);
          if (body.ok) waiter.resolve(true);
          else waiter.reject(new Error(body.reason || "Media rejected"));
        }
        return;
      }

      // Uploader finished sending chunks → assemble
      const inc = this._incoming.get(mediaId);
      if (!inc) return;
      try {
        const blob = blobFromBase64Chunks(
          inc.chunks.filter(Boolean),
          inc.meta.mime || "application/octet-stream",
        );
        /** @type {MediaEntry} */
        const entry = {
          mime: inc.meta.mime || blob.type || "application/octet-stream",
          size: Number(inc.meta.size) || blob.size,
          width: inc.meta.width,
          height: inc.meta.height,
          duration:
            inc.meta.duration != null ? Number(inc.meta.duration) : undefined,
          blob,
          senderPeerId: peerId,
          chatId: inc.meta.chatId,
          dmId: inc.meta.dmId,
        };

        if (inc.meta.dmId) {
          this.putLocalMedia(mediaId, entry);
        } else if (this.role === "host") {
          const ok = this._hostAcceptMedia(mediaId, entry);
          if (!ok) {
            this._incoming.delete(mediaId);
            this._send(
              encodeFrame("media-complete", {
                mediaId,
                ok: false,
                reason: "Host media budget exceeded",
              }),
              peerId,
            );
            return;
          }
        } else {
          // Guest receiving fetch from host
          this.putLocalMedia(mediaId, entry);
          this._fetching.delete(mediaId);
        }

        this._incoming.delete(mediaId);
        this._send(
          encodeFrame("media-complete", { mediaId, ok: true }),
          peerId,
        );
        log("media", "assembled", mediaId, entry.size);
        this.hooks.onChange();
      } catch (e) {
        this._incoming.delete(mediaId);
        this._fetching.delete(mediaId);
        this._send(
          encodeFrame("media-complete", {
            mediaId,
            ok: false,
            reason: e?.message || "Assemble failed",
          }),
          peerId,
        );
      }
      return;
    }

    if (type === "media-request") {
      const id = mediaId || String(body.mediaId || "").trim();
      const entry = this.mediaStore.get(id) || this.localMedia.get(id);
      if (!entry) {
        this._send(
          encodeFrame("media-reject", { mediaId: id, reason: "Unknown media" }),
          peerId,
        );
        return;
      }
      log("media", "serve request", id, "→", peerId);
      this._streamMediaTo(peerId, id, entry).catch((err) =>
        logError("media", "stream failed", err),
      );
      return;
    }

    if (type === "media-reject") {
      const waiter = this._uploadWaiters.get(mediaId);
      const reason = body.reason || "Media rejected";
      if (waiter) {
        this._uploadWaiters.delete(mediaId);
        waiter.reject(new Error(reason));
      }
      this._fetching.delete(mediaId);
      warn("media", "rejected", mediaId, reason);
      this.hooks.onError(`${reason}. ${MEDIA_TURN_HINT}`);
    }
  }

  /**
   * @param {string} mediaId
   * @param {MediaEntry} entry
   * @returns {boolean}
   */
  _hostAcceptMedia(mediaId, entry) {
    if (this.mediaStore.has(mediaId)) {
      this.putLocalMedia(mediaId, entry);
      return true;
    }
    if (this.hostMediaBytes + entry.size > HOST_MEDIA_BUDGET_BYTES) {
      warn("media", "budget exceeded", {
        have: this.hostMediaBytes,
        need: entry.size,
        budget: HOST_MEDIA_BUDGET_BYTES,
      });
      return false;
    }
    this.mediaStore.set(mediaId, entry);
    this.hostMediaBytes += entry.size;
    this.putLocalMedia(mediaId, entry);
    log("media", "host stored", mediaId, {
      bytes: this.hostMediaBytes,
      budget: HOST_MEDIA_BUDGET_BYTES,
    });
    return true;
  }

  /**
   * @param {string} peerId
   * @param {string} mediaId
   * @param {MediaEntry} entry
   * @param {{ chatId?: string, dmId?: string }} [scope]
   */
  async _transferMediaTo(peerId, mediaId, entry, scope = {}) {
    const chunks = await blobToBase64Chunks(entry.blob);
    const ack = this._waitUploadAck(mediaId);
    this._send(
      encodeFrame("media-offer", {
        mediaId,
        mime: entry.mime,
        size: entry.size,
        width: entry.width,
        height: entry.height,
        duration: entry.duration,
        chatId: scope.chatId,
        dmId: scope.dmId,
      }),
      peerId,
    );
    for (let index = 0; index < chunks.length; index++) {
      this._send(
        encodeFrame("media-chunk", {
          mediaId,
          index,
          total: chunks.length,
          data: chunks[index],
        }),
        peerId,
      );
    }
    this._send(encodeFrame("media-complete", { mediaId }), peerId);
    try {
      await ack;
    } catch (e) {
      const msg = e?.message || String(e);
      throw new Error(
        /timeout|reject/i.test(msg) ? `${msg}. ${MEDIA_TURN_HINT}` : msg,
      );
    }
  }

  /**
   * Stream without waiting for ack (response to media-request).
   * @param {string} peerId
   * @param {string} mediaId
   * @param {MediaEntry} entry
   */
  async _streamMediaTo(peerId, mediaId, entry) {
    const chunks = await blobToBase64Chunks(entry.blob);
    this._send(
      encodeFrame("media-offer", {
        mediaId,
        mime: entry.mime,
        size: entry.size,
        width: entry.width,
        height: entry.height,
        duration: entry.duration,
        chatId: entry.chatId,
        dmId: entry.dmId,
      }),
      peerId,
    );
    for (let index = 0; index < chunks.length; index++) {
      this._send(
        encodeFrame("media-chunk", {
          mediaId,
          index,
          total: chunks.length,
          data: chunks[index],
        }),
        peerId,
      );
    }
    this._send(encodeFrame("media-complete", { mediaId }), peerId);
  }

  /**
   * @param {string} mediaId
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  _waitUploadAck(mediaId, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._uploadWaiters.delete(mediaId);
        reject(new Error("Media transfer timeout"));
      }, timeoutMs);
      this._uploadWaiters.set(mediaId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /**
   * @param {string} [targetPeerId]
   */
  _sendHello(targetPeerId) {
    const displayName = this._pendingDisplayName || "Guest";
    log("guest", "send hello", { targetPeerId: targetPeerId || "*", displayName });
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
      if (this.connectedPeers.size) {
        log("guest", "hello retry", { peers: [...this.connectedPeers] });
        this._sendHello();
      } else {
        log("guest", "still no WebRTC peers — MQTT may be up, ICE/TURN likely failing");
      }
      this.hooks.onStatus(this._statusLabel());
    }, 2500);
  }

  _stopHelloRetry() {
    if (this._helloRetry != null) {
      clearInterval(this._helloRetry);
      this._helloRetry = null;
    }
  }

  _startDiag() {
    this._stopDiag();
    this._diagTimer = setInterval(() => {
      if (this.ended) {
        this._stopDiag();
        return;
      }
      if (this.role === "guest" && this.hostState) {
        this._stopDiag();
        return;
      }
      const peers = this._room?.getPeers?.() || {};
      const snap = Object.fromEntries(
        Object.entries(peers).map(([id, pc]) => [
          id,
          {
            ice: pc?.iceConnectionState,
            conn: pc?.connectionState,
            gather: pc?.iceGatheringState,
            signaling: pc?.signalingState,
          },
        ]),
      );
      log("diag", {
        role: this.role,
        sessionId: this._sessionId,
        connectedPeers: [...this.connectedPeers],
        awaitingHello: [...this._awaitingHello],
        hasHostState: Boolean(this.hostState),
        rtc: snap,
      });
    }, 5000);
  }

  _stopDiag() {
    if (this._diagTimer != null) {
      clearInterval(this._diagTimer);
      this._diagTimer = null;
    }
  }

  _send(frame, peerId) {
    if (!this._chat) {
      warn("send", "no chat action", frame?.type);
      return;
    }
    log("send", frame?.type, peerId ? `→ ${peerId}` : "→ *");
    const p = peerId
      ? this._chat.send(frame, { target: peerId })
      : this._chat.send(frame);
    if (p && typeof p.catch === "function") {
      p.catch((err) => logError("send", frame?.type, "failed", err));
    }
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

/**
 * @param {Blob[]} files
 * @returns {{ files: Blob[], mediaKind: "image" | "video" }}
 */
function classifyMediaBatch(files) {
  if (!files?.length) throw new Error("No media files");
  const videos = files.filter((f) => f.type.startsWith("video/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  if (videos.length + images.length !== files.length) {
    throw new Error("Unsupported file type");
  }
  if (videos.length && images.length) {
    throw new Error("Cannot mix photos and video in one send");
  }
  if (videos.length > 1) {
    throw new Error("Send one video at a time");
  }
  if (videos.length === 1) {
    return { files: [videos[0]], mediaKind: "video" };
  }
  if (images.length > MAX_ALBUM_ITEMS) {
    throw new Error(`Album max ${MAX_ALBUM_ITEMS} images`);
  }
  return { files: images, mediaKind: "image" };
}
