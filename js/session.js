import {
  APP_ID,
  APP_VERSION,
  MAX_ALBUM_ITEMS,
  MEDIA_CHUNK_BYTES,
  MEDIA_TURN_HINT,
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
  blobSliceToBase64Url,
  captureVideoThumbDataUrl,
  compressImage,
  formatBytes,
  isDeferredPlayableSize,
  isGatedPlayableMime,
  mediaChunkCount,
  mintMediaId,
  prepareAudio,
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
 *   onProgress?: (label: string) => void,
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
    /** @type {Map<string, MediaEntry>} blobs this peer holds (own sends + P2P downloads) */
    this.localMedia = new Map();
    /** @type {Map<string, { meta: object, chunks: string[], from: string }>} */
    this._incoming = new Map();
    /** @type {Set<string>} */
    this._fetching = new Set();
    /** @type {Map<string, { size: number, mime?: string, duration?: number, senderPeerId?: string, thumbDataUrl?: string }>} */
    this._mediaMeta = new Map();
    /** @type {Set<string>} mediaIds user tapped Download for (or own sends). */
    this._mediaUnlocked = new Set();
  }

  /**
   * @param {string} mediaId
   * @returns {string | null} object URL
   */
  getMediaUrl(mediaId) {
    const entry = this.localMedia.get(mediaId);
    if (!entry?.blob) return null;
    if (!entry.objectUrl) {
      entry.objectUrl = URL.createObjectURL(entry.blob);
      this.localMedia.set(mediaId, entry);
    }
    return entry.objectUrl;
  }

  /**
   * URL only if local playback is allowed (own send, small auto-dl, or tapped Download).
   * @param {string} mediaId
   * @param {{ size?: number, mime?: string, outgoing?: boolean }} [gate]
   */
  getPlayableMediaUrl(mediaId, gate = {}) {
    const size =
      Number(gate.size) ||
      this._mediaMeta.get(mediaId)?.size ||
      this.getMediaEntry(mediaId)?.size ||
      0;
    const mime = String(
      gate.mime ||
        this._mediaMeta.get(mediaId)?.mime ||
        this.getMediaEntry(mediaId)?.mime ||
        "",
    ).toLowerCase();
    const large =
      isGatedPlayableMime(mime) && isDeferredPlayableSize(size);
    if (large && !gate.outgoing && !this._mediaUnlocked.has(mediaId)) {
      return null;
    }
    return this.getMediaUrl(mediaId);
  }

  /** @param {string} mediaId @returns {MediaEntry | undefined} */
  getMediaEntry(mediaId) {
    return this.localMedia.get(mediaId);
  }

  /** @param {string} mediaId */
  unlockMedia(mediaId) {
    if (mediaId) this._mediaUnlocked.add(mediaId);
  }

  /** @param {string} mediaId */
  isMediaUnlocked(mediaId) {
    return this._mediaUnlocked.has(mediaId);
  }

  /** @param {string} mediaId */
  getMediaMeta(mediaId) {
    return this._mediaMeta.get(mediaId);
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
   * Prepare group media on the sender only. Bytes stay local; roster peers pull
   * via media-request → senderPeerId. Host gets message metadata only (not bytes).
   * Videos over VIDEO_AUTO_DOWNLOAD_BYTES also get a tiny poster thumb in mediaInfo.
   * @param {Blob[]} files
   * @param {{ chatId?: string, onProgress?: (label: string) => void }} [opts]
   * @returns {Promise<{ mediaIds: string[], mediaKind?: "video" | "audio", mediaInfo?: object[] }>}
   */
  async prepareGroupMedia(files, opts = {}) {
    if (!this.hostState) throw new Error("No session");
    const batch = classifyMediaBatch(files);

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
      const deferredVideo =
        batch.mediaKind === "video" && isDeferredPlayableSize(prepared.size);
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

      /** @type {string | undefined} */
      let thumbDataUrl;
      if (deferredVideo) {
        opts.onProgress?.("Making thumbnail…");
        thumbDataUrl = await captureVideoThumbDataUrl(prepared.blob);
      }
      // Sender keeps the bytes; peers fetch via media-request → senderPeerId.
      this.putLocalMedia(mediaId, entry);
      this.unlockMedia(mediaId);
      opts.onProgress?.("Posting…");

      mediaIds.push(mediaId);
      this._mediaMeta.set(mediaId, {
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        senderPeerId: this.selfPeerId,
      });
      mediaInfo.push({
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        width: prepared.width,
        height: prepared.height,
        thumbDataUrl,
      });
    }
    /** @type {"video" | "audio" | undefined} */
    let mediaKind;
    if (batch.mediaKind === "video") mediaKind = "video";
    else if (batch.mediaKind === "audio") mediaKind = "audio";
    return {
      mediaIds,
      mediaInfo,
      mediaKind,
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
   * Prepare DM media on the sender only; peer pulls via media-request (same as groups).
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
      const deferredVideo =
        batch.mediaKind === "video" && isDeferredPlayableSize(prepared.size);
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
      this.unlockMedia(mediaId);

      /** @type {string | undefined} */
      let thumbDataUrl;
      if (deferredVideo) {
        opts.onProgress?.("Making thumbnail…");
        thumbDataUrl = await captureVideoThumbDataUrl(prepared.blob);
      }
      opts.onProgress?.("Posting…");
      mediaIds.push(mediaId);
      this._mediaMeta.set(mediaId, {
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        senderPeerId: this.selfPeerId,
      });
      mediaInfo.push({
        size: prepared.size,
        mime: prepared.mime,
        duration: prepared.duration,
        width: prepared.width,
        height: prepared.height,
        thumbDataUrl,
      });
    }

    /** @type {"video" | "audio" | undefined} */
    let mediaKind;
    if (batch.mediaKind === "video") mediaKind = "video";
    else if (batch.mediaKind === "audio") mediaKind = "audio";

    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-send-media",
      dmId,
      mediaIds,
      mediaInfo,
      text: opts.text,
      entities: opts.entities,
      replyTo: opts.replyTo,
      mediaKind,
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
        mediaKind,
      }),
      other,
    );
    this.hooks.onChange();
  }

  /**
   * @param {Blob} file
   * @param {"image" | "video" | "audio"} kind
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
    if (kind === "audio") {
      onLabel?.("Preparing audio");
      const a = await prepareAudio(file);
      return {
        blob: a.blob,
        mime: a.mime,
        width: 0,
        height: 0,
        duration: a.duration,
        size: a.size,
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
   * Pull missing media P2P from the original sender (roster peer).
   * Host is not a media CDN — only roster/admin + message relay.
   * Large videos skip until force (Download tap).
   * @param {string[]} mediaIds
   * @param {{ force?: boolean, sizes?: Record<string, number>, mimes?: Record<string, string>, senders?: Record<string, string> }} [opts]
   */
  ensureMedia(mediaIds, opts = {}) {
    for (const id of mediaIds || []) {
      if (!id) continue;
      if (opts.force) this.unlockMedia(id);
      const meta = this._mediaMeta.get(id);
      const knownSize = opts.sizes?.[id] ?? meta?.size ?? 0;
      const mime = String(opts.mimes?.[id] || meta?.mime || "").toLowerCase();
      const senderPeerId =
        opts.senders?.[id] || meta?.senderPeerId || undefined;
      const largeLocked =
        isGatedPlayableMime(mime) &&
        isDeferredPlayableSize(knownSize) &&
        !opts.force &&
        !this._mediaUnlocked.has(id);
      if (largeLocked) {
        log("media", "skip auto-download (large)", id, knownSize);
        continue;
      }
      if (this.localMedia.has(id)) {
        if (opts.force) this.hooks.onChange();
        continue;
      }
      if (this._fetching.has(id)) continue;

      const target = senderPeerId;
      if (!target || target === this.selfPeerId) {
        if (opts.force) {
          this.hooks.onError(
            "Media is only on the sender’s device — they may be offline.",
          );
        }
        continue;
      }
      if (!this.connectedPeers.has(target)) {
        if (opts.force) {
          this.hooks.onError(
            "Sender is offline — cannot download media right now.",
          );
        }
        continue;
      }

      this._fetching.add(id);
      log("media", "request P2P", id, "→", target);
      const sizeLabel = knownSize ? formatBytes(knownSize) : "";
      this.hooks.onProgress?.(
        sizeLabel ? `Downloading… 0% · 0 B / ${sizeLabel}` : "Downloading…",
      );
      this._send(encodeFrame("media-request", { mediaId: id }), target);
    }
  }

  /**
   * @param {string} mediaId
   * @param {{ total?: number, size?: number, chunks?: string[] }} inc
   */
  _reportDownloadProgress(mediaId, inc) {
    const total = Number(inc.total) || 0;
    if (!total) return;
    let have = 0;
    for (let i = 0; i < total; i++) {
      if (typeof inc.chunks?.[i] === "string" && inc.chunks[i]) have += 1;
    }
    const size =
      Number(inc.size) ||
      this._mediaMeta.get(mediaId)?.size ||
      0;
    const pct = Math.min(100, Math.round((have / total) * 100));
    const got = size ? Math.round((have / total) * size) : 0;
    this.hooks.onProgress?.(
      size
        ? `Downloading ${pct}% · ${formatBytes(got)} / ${formatBytes(size)}`
        : `Downloading ${pct}%`,
    );
  }

  /**
   * Remember size/mime/sender from messages so large-video UI can show before fetch.
   * @param {import("./engine.js").Message} message
   */
  rememberMediaInfo(message) {
    if (!message?.mediaIds?.length) return;
    const infos = message.mediaInfo || [];
    message.mediaIds.forEach((id, i) => {
      const info = infos[i];
      if (!info && !message.senderPeerId) return;
      const prev = this._mediaMeta.get(id) || {};
      this._mediaMeta.set(id, {
        size: Number(info?.size) || prev.size || 0,
        mime: info?.mime || prev.mime,
        duration: info?.duration ?? prev.duration,
        senderPeerId: message.senderPeerId || prev.senderPeerId,
        thumbDataUrl: info?.thumbDataUrl || prev.thumbDataUrl,
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
          const mimes = Object.create(null);
          const senders = Object.create(null);
          body.message.mediaIds.forEach((id, i) => {
            const sz = body.message.mediaInfo?.[i]?.size;
            if (sz != null) sizes[id] = sz;
            const mime = body.message.mediaInfo?.[i]?.mime;
            if (mime) mimes[id] = mime;
            if (body.message.senderPeerId) {
              senders[id] = body.message.senderPeerId;
            }
          });
          if (body.message.senderPeerId === this.selfPeerId) {
            body.message.mediaIds.forEach((id) => this.unlockMedia(id));
          }
          this.ensureMedia(body.message.mediaIds, { sizes, mimes, senders });
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
        const msg = r.message || body.message;
        if (msg) {
          this.rememberMediaInfo(msg);
          if (msg.mediaIds?.length) {
            const sizes = Object.create(null);
            const mimes = Object.create(null);
            const senders = Object.create(null);
            msg.mediaIds.forEach((id, i) => {
              const sz = msg.mediaInfo?.[i]?.size;
              if (sz != null) sizes[id] = sz;
              const mime = msg.mediaInfo?.[i]?.mime;
              if (mime) mimes[id] = mime;
              senders[id] = msg.senderPeerId || peerId;
            });
            this.ensureMedia(msg.mediaIds, { sizes, mimes, senders });
          }
        }
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
   * Media bytes are fetched P2P only if we are a group member (host admin of other
   * groups must not pull every group's media just because they see the events).
   * @param {import("./engine.js").Effect[]} effects
   */
  _ackFromEffects(effects) {
    for (const effect of effects) {
      if (effect.event === "message-added" && effect.message) {
        const chatId = effect.chatId || effect.message.chatId;
        this._ackGroupMessage(chatId, effect.message);
        this.rememberMediaInfo(effect.message);
        if (!effect.message.mediaIds?.length) continue;
        const chat = chatId ? this.hostState?.groups[chatId] : null;
        const member = Boolean(
          chat?.memberPeerIds?.includes(this.selfPeerId),
        );
        if (!member) continue;
        const sizes = Object.create(null);
        const mimes = Object.create(null);
        const senders = Object.create(null);
        effect.message.mediaIds.forEach((id, i) => {
          const sz = effect.message.mediaInfo?.[i]?.size;
          if (sz != null) sizes[id] = sz;
          const mime = effect.message.mediaInfo?.[i]?.mime;
          if (mime) mimes[id] = mime;
          if (effect.message.senderPeerId) {
            senders[id] = effect.message.senderPeerId;
          }
        });
        if (effect.message.senderPeerId === this.selfPeerId) {
          effect.message.mediaIds.forEach((id) => this.unlockMedia(id));
        }
        this.ensureMedia(effect.message.mediaIds, { sizes, mimes, senders });
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
      // Pull-only: accept offers only after we media-request'd (group or DM).
      // Rejects legacy guest→host pushes and unsolicited DM blasts.
      if (!this._fetching.has(mediaId) && !this._incoming.has(mediaId)) {
        warn("media", "ignore unsolicited offer", mediaId, "from", peerId);
        return;
      }
      if (body.dmId) {
        const expected = dmIdFor(this.selfPeerId, peerId);
        if (body.dmId !== expected) {
          warn("media", "ignore DM offer for other pair", body.dmId);
          return;
        }
      }
      const total = Number(body.total);
      log("media", "offer", mediaId, {
        size: body.size,
        total: Number.isFinite(total) ? total : undefined,
        from: peerId,
        dm: Boolean(body.dmId),
      });
      const prevMeta = this._mediaMeta.get(mediaId) || {};
      this._mediaMeta.set(mediaId, {
        ...prevMeta,
        size: Number(body.size) || prevMeta.size || 0,
        mime: body.mime || prevMeta.mime,
        duration:
          body.duration != null
            ? Number(body.duration)
            : prevMeta.duration,
        // Holder of the bytes (usually original sender).
        senderPeerId: prevMeta.senderPeerId || peerId,
      });
      const prev = this._incoming.get(mediaId);
      if (prev?.assembleTimer != null) clearTimeout(prev.assembleTimer);
      this._incoming.set(mediaId, {
        meta: body,
        chunks: /** @type {string[]} */ ([]),
        total: Number.isFinite(total) && total > 0 ? total : 0,
        size: Number(body.size) || 0,
        from: peerId,
        completeSignaled: false,
        assembleTimer: null,
        lastProgressAt: 0,
      });
      const offerSize = Number(body.size) || 0;
      if (offerSize) {
        this.hooks.onProgress?.(
          `Downloading… 0% · 0 B / ${formatBytes(offerSize)}`,
        );
      }
      return;
    }

    if (type === "media-chunk") {
      const inc = this._incoming.get(mediaId);
      if (!inc) return;
      const index = Number(body.index);
      const total = Number(body.total);
      if (!Number.isInteger(index) || index < 0) return;
      if (typeof body.data !== "string" || !body.data) return;
      if (Number.isFinite(total) && total > 0) inc.total = total;
      const wasMissing = typeof inc.chunks[index] !== "string" || !inc.chunks[index];
      inc.chunks[index] = body.data;
      if (wasMissing) {
        const now = Date.now();
        if (
          index === 0 ||
          index + 1 === inc.total ||
          (index + 1) % 8 === 0 ||
          now - (inc.lastProgressAt || 0) > 200
        ) {
          inc.lastProgressAt = now;
          this._reportDownloadProgress(mediaId, inc);
        }
      }
      if (inc.completeSignaled) this._tryAssembleIncoming(mediaId, peerId);
      return;
    }

    if (type === "media-complete") {
      // Receiver→sender ack after assemble (pull model; no upload waiter).
      if (typeof body.ok === "boolean") {
        if (!body.ok) {
          warn("media", "peer rejected transfer", mediaId, body.reason);
        }
        return;
      }

      // Sender finished streaming chunks → assemble when all chunks present
      const inc = this._incoming.get(mediaId);
      if (!inc) return;
      inc.completeSignaled = true;
      if (!this._tryAssembleIncoming(mediaId, peerId)) {
        if (inc.assembleTimer != null) clearTimeout(inc.assembleTimer);
        inc.assembleTimer = setTimeout(() => {
          this._failIncomingMedia(
            mediaId,
            peerId,
            "Incomplete media transfer (missing chunks)",
          );
        }, 20_000);
      }
      return;
    }

    if (type === "media-request") {
      const id = mediaId || String(body.mediaId || "").trim();
      const entry = this.localMedia.get(id);
      if (!entry) {
        this._send(
          encodeFrame("media-reject", { mediaId: id, reason: "Unknown media" }),
          peerId,
        );
        return;
      }
      log("media", "serve P2P", id, "→", peerId);
      this._streamMediaTo(peerId, id, entry).catch((err) =>
        logError("media", "stream failed", err),
      );
      return;
    }

    if (type === "media-reject") {
      const reason = body.reason || "Media rejected";
      this._fetching.delete(mediaId);
      this.hooks.onProgress?.("");
      warn("media", "rejected", mediaId, reason);
      this.hooks.onError(`${reason}. ${MEDIA_TURN_HINT}`);
    }
  }

  /**
   * Assemble only when every chunk index is present; never skip gaps.
   * @param {string} mediaId
   * @param {string} peerId
   * @returns {boolean} true if assembled or failed (incoming cleared)
   */
  _tryAssembleIncoming(mediaId, peerId) {
    const inc = this._incoming.get(mediaId);
    if (!inc?.completeSignaled) return false;
    const total = Number(inc.total);
    if (!Number.isInteger(total) || total <= 0) return false;
    for (let i = 0; i < total; i++) {
      if (typeof inc.chunks[i] !== "string" || !inc.chunks[i]) return false;
    }

    if (inc.assembleTimer != null) {
      clearTimeout(inc.assembleTimer);
      inc.assembleTimer = null;
    }

    try {
      /** @type {string[]} */
      const ordered = [];
      for (let i = 0; i < total; i++) ordered.push(inc.chunks[i]);
      const blob = blobFromBase64Chunks(
        ordered,
        inc.meta.mime || "application/octet-stream",
      );
      const expected = Number(inc.meta.size) || 0;
      if (expected > 0 && blob.size !== expected) {
        throw new Error(
          `Media size mismatch (${blob.size} ≠ ${expected})`,
        );
      }

      /** @type {MediaEntry} */
      const entry = {
        mime: inc.meta.mime || blob.type || "application/octet-stream",
        size: blob.size,
        width: inc.meta.width,
        height: inc.meta.height,
        duration:
          inc.meta.duration != null ? Number(inc.meta.duration) : undefined,
        blob,
        senderPeerId: peerId,
        chatId: inc.meta.chatId,
        dmId: inc.meta.dmId,
      };

      // Any peer (including host) keeps a local copy only — no session-wide media CDN.
      this.putLocalMedia(mediaId, entry);
      this._fetching.delete(mediaId);
      const largeGated =
        isGatedPlayableMime(entry.mime) && isDeferredPlayableSize(entry.size);
      if (!largeGated) this.unlockMedia(mediaId);

      this._incoming.delete(mediaId);
      this._send(
        encodeFrame("media-complete", { mediaId, ok: true }),
        peerId,
      );
      log("media", "assembled", mediaId, entry.size, `${total} chunks`);
      this.hooks.onProgress?.(
        `Downloading 100% · ${formatBytes(entry.size)} / ${formatBytes(entry.size)}`,
      );
      this.hooks.onProgress?.("");
      this.hooks.onChange();
      return true;
    } catch (e) {
      this._failIncomingMedia(
        mediaId,
        peerId,
        e?.message || "Assemble failed",
      );
      return true;
    }
  }

  /**
   * @param {string} mediaId
   * @param {string} peerId
   * @param {string} reason
   */
  _failIncomingMedia(mediaId, peerId, reason) {
    const inc = this._incoming.get(mediaId);
    if (inc?.assembleTimer != null) clearTimeout(inc.assembleTimer);
    this._incoming.delete(mediaId);
    this._fetching.delete(mediaId);
    this.hooks.onProgress?.("");
    warn("media", "assemble failed", mediaId, reason);
    this._send(
      encodeFrame("media-complete", {
        mediaId,
        ok: false,
        reason,
      }),
      peerId,
    );
  }

  /**
   * Stream chunks from blob (no full-file base64 array) with SCTP pacing.
   * @param {string} peerId
   * @param {string} mediaId
   * @param {Blob} blob
   * @param {object} offerBody
   * @param {{ onProgress?: (label: string) => void }} [opts]
   */
  async _sendMediaChunks(peerId, mediaId, blob, offerBody, opts = {}) {
    const total = mediaChunkCount(blob.size, MEDIA_CHUNK_BYTES);
    this._send(
      encodeFrame("media-offer", {
        ...offerBody,
        mediaId,
        size: blob.size,
        total,
      }),
      peerId,
    );
    for (let index = 0; index < total; index++) {
      const offset = index * MEDIA_CHUNK_BYTES;
      const data = await blobSliceToBase64Url(blob, offset, MEDIA_CHUNK_BYTES);
      this._send(
        encodeFrame("media-chunk", {
          mediaId,
          index,
          total,
          data,
        }),
        peerId,
      );
      if (index === 0 || index + 1 === total || (index + 1) % 16 === 0) {
        const sent = Math.min(offset + MEDIA_CHUNK_BYTES, blob.size);
        const pct = Math.min(100, Math.round(((index + 1) / total) * 100));
        opts.onProgress?.(
          `Sending ${pct}% · ${formatBytes(sent)} / ${formatBytes(blob.size)}`,
        );
      }
      if ((index + 1) % 8 === 0) {
        await new Promise((r) => setTimeout(r, 8));
      } else {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this._send(encodeFrame("media-complete", { mediaId }), peerId);
  }

  /**
   * Stream local bytes to a peer that media-request'd them (P2P pull).
   * @param {string} peerId
   * @param {string} mediaId
   * @param {MediaEntry} entry
   */
  async _streamMediaTo(peerId, mediaId, entry) {
    await this._sendMediaChunks(peerId, mediaId, entry.blob, {
      mime: entry.mime,
      size: entry.size,
      width: entry.width,
      height: entry.height,
      duration: entry.duration,
      chatId: entry.chatId,
      dmId: entry.dmId,
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
 * @returns {{ files: Blob[], mediaKind: "image" | "video" | "audio" }}
 */
function classifyMediaBatch(files) {
  if (!files?.length) throw new Error("No media files");
  const videos = files.filter((f) => f.type.startsWith("video/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  const audios = files.filter((f) => f.type.startsWith("audio/"));
  if (videos.length + images.length + audios.length !== files.length) {
    throw new Error("Unsupported file type");
  }
  const kinds =
    (videos.length ? 1 : 0) + (images.length ? 1 : 0) + (audios.length ? 1 : 0);
  if (kinds > 1) {
    throw new Error("Cannot mix photos, video, and audio in one send");
  }
  if (videos.length > 1) {
    throw new Error("Send one video at a time");
  }
  if (audios.length > 1) {
    throw new Error("Send one audio at a time");
  }
  if (videos.length === 1) {
    return { files: [videos[0]], mediaKind: "video" };
  }
  if (audios.length === 1) {
    return { files: [audios[0]], mediaKind: "audio" };
  }
  if (images.length > MAX_ALBUM_ITEMS) {
    throw new Error(`Album max ${MAX_ALBUM_ITEMS} images`);
  }
  return { files: images, mediaKind: "image" };
}
