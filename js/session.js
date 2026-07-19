import {
  APP_ID,
  APP_VERSION,
  MAX_ALBUM_ITEMS,
  MEDIA_CHUNK_BYTES,
  MEDIA_TURN_HINT,
} from "./constants.js";
import {
  claimContinuity,
  continuityPubKey,
  loadOrCreateContinuity,
  verifyContinuity,
} from "./continuity.js";
import {
  addRosterPeer,
  appendSystemToGroups,
  applyDm,
  applyHost,
  applyHostEvent,
  bumpHostRevision,
  createEmptyDmState,
  createHostState,
  fanoutPeerIdsForGroup,
  filterHostStateForPeer,
  getHostPeerId,
  mergeHostSnapshots,
  remapRosterPeer,
  removeRosterPeer,
  setRosterOnline,
} from "./engine.js";
import {
  makeSessionId,
  deriveTopic,
  dmIdFor,
  normalizePermanentRoomId,
  permanentSessionId,
} from "./ids.js";
import { mintInviteUrl, mintPermanentRoomUrl } from "./invite.js";
import { error as logError, log, warn } from "./log.js";
import { deriveHandle, verifyHandle } from "./tripcode.js";
import {
  blobFromBase64Chunks,
  blobSliceToBase64Url,
  captureVideoThumbDataUrl,
  compressImage,
  formatBytes,
  isDeferredPlayableSize,
  isDeferredTransferMime,
  mediaChunkCount,
  mintMediaId,
  prepareAudio,
  prepareFile,
  prepareVideo,
} from "./media.js";
import {
  decodeFrame,
  encodeFrame,
  encodeRoomControlFrame,
  isRoomControlFrame,
} from "./protocol.js";
import { remapDmPeer, remapHostPeer } from "./resume.js";
import { fetchStickerBytes, getPack, upsertPack } from "./stickers.js";
import { getStickerBlob, putSticker } from "./sticker-cache.js";
import {
  canRestorePermanentRoom,
  compareHostClaims,
  HOST_GRACE_MS,
  pickElectionWinner,
} from "./rooms.js";
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
    /** @type {"host" | "guest" | "candidate" | null} */
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
    /** @type {string} optional room password (gates topic + keys; never shared in invite) */
    this._password = "";
    /** @type {string} optional identity-code passphrase (derives the tripcode handle) */
    this._tripcode = "";
    /** @type {{ id: string, pub: string, sig: string } | null} derived handle for this session */
    this._handle = null;
    /** @type {import("./continuity.js").ContinuityHandle | null} */
    this._continuity = null;
    /** @type {string} logical host id from the invite, when available */
    this._hostHint = "";
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
    /** True once we've proven we can reach the sticker site (fetch or CDN load). */
    this._stickerSiteReachable = false;
    /** @type {Map<string, { pack: string, stickerId: string, tried: Set<string>, broadcastTimer: ReturnType<typeof setTimeout> | null, giveUpTimer: ReturnType<typeof setTimeout> | null }>} in-flight sticker pulls */
    this._stickerPulls = new Map();
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._hostGraceTimer = null;
    this.roomMode = "random";
    this.permanentRoomId = "";
    this.electionTerm = 0;
    this.leaseExpiry = 0;
    this._candidateIds = new Set();
    this._hostClaimTimer = null;
    this._hostLeaseTimer = null;
    this._electionTimer = null;
    this._stateOffers = new Map();
    this._electionEpoch = 0;
    this._continuing = false;
    this._permanentHostMissing = false;
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
      isDeferredTransferMime(mime) && isDeferredPlayableSize(size);
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
   * @param {{
   *   displayName: string,
   *   title?: string,
   *   sessionId?: string,
   *   restoreHostState?: object,
   *   restoreDmState?: object,
   *   previousHostPeerId?: string,
   *   password?: string,
   * }} opts
   */
  async createHost(opts) {
    const displayName = String(opts.displayName || "").trim() || "Host";
    const title = String(opts.title || "").trim() || "Session";
    const sessionId = String(opts.sessionId || "").trim() || makeSessionId();
    this._sessionId = sessionId;
    this._password = String(opts.password || "");
    this._tripcode = String(opts.tripcode || "");
    this.hooks.onStatus("Connecting…");

    const { joinRoom, selfId } = await loadTrystero(sessionId, this._password);
    this.selfPeerId = selfId;
    this.role = "host";
    this._handle = await deriveHandle(this._tripcode, selfId);
    this._continuity = await loadOrCreateContinuity(sessionId);
    const hostContPub = this._continuity?.pub || undefined;
    log("host", "trystero loaded", { selfId });

    if (opts.restoreHostState) {
      const oldHost =
        opts.previousHostPeerId ||
        opts.restoreHostState.roster?.find((r) => r.role === "host")?.peerId ||
        "";
      this.hostState = remapHostPeer(
        opts.restoreHostState,
        oldHost,
        selfId,
        displayName,
      );
      this.hostState.session = {
        ...this.hostState.session,
        id: sessionId,
        title: title || this.hostState.session?.title || "Session",
        ended: false,
      };
      // Refresh host entry's trip / continuity after possible peerId change.
      this.hostState.roster = this.hostState.roster.map((r) =>
        r.peerId === selfId
          ? {
              ...r,
              trip: this._handle || undefined,
              contPub: hostContPub || r.contPub,
              online: true,
            }
          : r,
      );
      this.dmState = opts.restoreDmState || createEmptyDmState();
      log("host", "session resumed", { sessionId, oldHost, selfId });
    } else {
      this.hostState = createHostState({
        sessionId,
        title,
        hostPeer: {
          peerId: selfId,
          displayName,
          role: "host",
          joinedAt: Date.now(),
          colorIndex: 0,
          trip: this._handle || undefined,
          contPub: hostContPub,
          online: true,
        },
      });
      this.dmState = createEmptyDmState();
      log("host", "session minted", { sessionId, title });
    }

    this.inviteUrl = mintInviteUrl(sessionId, location.href, selfId);
    log("host", "invite", this.inviteUrl);

    await this._joinRoom(joinRoom, sessionId);
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
    return this;
  }

  /**
   * @param {{ displayName: string, sessionId: string, hostPeerId?: string, password?: string, tripcode?: string }} opts
   */
  async joinGuest(opts) {
    const displayName = String(opts.displayName || "").trim() || "Guest";
    const sessionId = String(opts.sessionId || "").trim();
    if (!sessionId) throw new Error("Missing session id");

    this.hooks.onStatus("Connecting…");
    this._password = String(opts.password || "");
    this._tripcode = String(opts.tripcode || "");
    const { joinRoom, selfId } = await loadTrystero(sessionId, this._password);
    this.selfPeerId = selfId;
    this.role = "guest";
    this._handle = await deriveHandle(this._tripcode, selfId);
    this._continuity = await loadOrCreateContinuity(sessionId);
    this.dmState = createEmptyDmState();
    this._pendingDisplayName = displayName;
    this._sessionId = sessionId;
    this._hostHint = String(opts.hostPeerId || "").trim();
    log("guest", "joining", { selfId, sessionId, displayName });

    await this._joinRoom(joinRoom, sessionId);
    this._sendHello(this._hostHint || undefined).catch((err) =>
      logError("guest", "initial hello failed", err),
    );
    this._startHelloRetry();
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
    return this;
  }

  /**
   * Join a reusable host-independent room, discover its host, or take part in
   * deterministic election when no valid host claim is reachable.
   * @param {{ displayName: string, roomId: string, resume?: object, password?: string, tripcode?: string }} opts
   */
  async enterPermanentRoom(opts) {
    const displayName = String(opts.displayName || "").trim() || "Member";
    const roomId = normalizePermanentRoomId(opts.roomId);
    const sessionId = await permanentSessionId(roomId);
    this.roomMode = "permanent";
    this.permanentRoomId = roomId;
    this._sessionId = sessionId;
    this._password = String(opts.password || "");
    this._tripcode = String(opts.tripcode || "");
    this._pendingDisplayName = displayName;
    this.inviteUrl = mintPermanentRoomUrl(roomId);
    this.role = "candidate";
    const canRestore = canRestorePermanentRoom(opts.resume, roomId);
    this.dmState = canRestore
      ? opts.resume?.dmState || createEmptyDmState()
      : createEmptyDmState();
    this.electionTerm = canRestore
      ? Number(opts.resume?.electionTerm) || 0
      : 0;
    this.hooks.onStatus("Looking for room");

    const { joinRoom, selfId } = await loadTrystero(sessionId, this._password);
    this.selfPeerId = selfId;
    this._handle = await deriveHandle(this._tripcode, selfId);
    this._continuity = await loadOrCreateContinuity(sessionId);
    this._candidateIds = new Set([selfId]);
    if (
      canRestore &&
      opts.resume?.hostState
    ) {
      this.hostState = opts.resume.hostState;
    }
    await this._joinRoom(joinRoom, sessionId);
    if (
      canRestore &&
      opts.resume?.role === "host" &&
      this.hostState &&
      Number(opts.resume.leaseExpiry) > Date.now()
    ) {
      this.role = "host";
      this._startHostClaims();
      this._sendHostClaim();
      this.hooks.onStatus(this._statusLabel());
      return this;
    }
    this._sendRoomPresence();
    this._scheduleElection(3_000);
    this.hooks.onChange();
    return this;
  }

  /**
   * @param {{ endSession?: boolean }} [opts]
   *   endSession=false skips broadcasting session-ended (used on refresh when resuming).
   */
  leave(opts = {}) {
    const endSession = opts.endSession !== false;
    this._stopHelloRetry();
    this._stopDiag();
    this._clearHostGrace();
    this._clearElectionTimers();
    if (
      endSession &&
      this.role === "host" &&
      this.hostState &&
      !this.sessionEnded
    ) {
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

  /** Snapshot for sessionStorage resume. */
  getResumeSnapshot() {
    if (!this._sessionId) return null;
    return {
      role: this.role,
      sessionId: this._sessionId,
      password: this._password || undefined,
      tripcode: this._tripcode || undefined,
      displayName:
        this.hostState?.roster?.find((r) => r.peerId === this.selfPeerId)
          ?.displayName ||
        this._pendingDisplayName ||
        "User",
      title: this.hostState?.session?.title,
      dmState: this.dmState,
      previousHostPeerId:
        this.role === "host" ? this.selfPeerId : undefined,
      previousSelfPeerId: this.selfPeerId,
      hostPeerId:
        this.role === "guest"
          ? this._hostHint || (this.hostState && getHostPeerId(this.hostState))
          : this.selfPeerId,
      roomMode: this.roomMode,
      permanentRoomId: this.permanentRoomId || undefined,
      electionTerm:
        this.roomMode === "permanent" ? this.electionTerm : undefined,
      leaseExpiry:
        this.roomMode === "permanent" ? this.leaseExpiry : undefined,
      hostState:
        this.role === "host" || this.roomMode === "permanent"
          ? this.hostState
          : undefined,
    };
  }

  /**
   * @param {object} action
   */
  dispatchHostAction(action) {
    if (!this.hostState || this.sessionEnded) return;
    if (this.role === "host") {
      const groupsBefore =
        action.type === "create-group"
          ? new Set(Object.keys(this.hostState.groups || {}))
          : null;
      const result = applyHost(this.hostState, action, {
        actorPeerId: this.selfPeerId,
      });
      if (!result.ok) {
        this.hooks.onError(result.error);
        return;
      }
      this.hostState = bumpHostRevision(result.state, action);
      this._emitEffects(result.effects, /* skipSelf */ true);
      this._ackFromEffects(result.effects);
      if (action.type === "admin-kick" && action.peerId) {
        this._broadcastRoster();
        this._send(
          encodeFrame("peer-kicked", {
            peerId: action.peerId,
            reason: "kicked",
          }),
          action.peerId,
        );
      }
      if (this.hostState.session.ended) {
        this.ended = true;
        this._send(encodeFrame("session-ended", { reason: "ended" }));
      }
      this.hooks.onChange();
      if (groupsBefore) {
        // Newly minted group id (host mints synchronously) so the caller can
        // auto-open the group the local user just created.
        const createdId = Object.keys(this.hostState.groups).find(
          (id) => !groupsBefore.has(id),
        );
        return createdId || undefined;
      }
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
   * @returns {Promise<{ mediaIds: string[], mediaKind?: "video" | "audio" | "file", mediaInfo?: object[] }>}
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
        fileName: prepared.fileName,
      });
    }
    /** @type {"video" | "audio" | "file" | undefined} */
    let mediaKind;
    if (batch.mediaKind === "video") mediaKind = "video";
    else if (batch.mediaKind === "audio") mediaKind = "audio";
    else if (batch.mediaKind === "file") mediaKind = "file";
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
        fileName: prepared.fileName,
      });
    }

    /** @type {"video" | "audio" | "file" | undefined} */
    let mediaKind;
    if (batch.mediaKind === "video") mediaKind = "video";
    else if (batch.mediaKind === "audio") mediaKind = "audio";
    else if (batch.mediaKind === "file") mediaKind = "file";

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
   * @param {"image" | "video" | "audio" | "file"} kind
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
    if (kind === "file") {
      onLabel?.("Preparing file");
      const f = await prepareFile(file);
      return {
        blob: f.blob,
        mime: f.mime,
        width: 0,
        height: 0,
        size: f.size,
        fileName: f.fileName,
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
        isDeferredTransferMime(mime) &&
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
        // Keep original uploader when a forward re-announces the same mediaId.
        senderPeerId: prev.senderPeerId || message.senderPeerId,
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
   * @param {string} chatId
   * @param {string} messageId
   * @param {string} emoji
   */
  setGroupReaction(chatId, messageId, emoji) {
    this.dispatchHostAction({
      type: "set-reaction",
      chatId,
      messageId,
      emoji,
    });
  }

  /**
   * @param {string} dmId
   * @param {string} messageId
   * @param {string} emoji
   */
  setDmReaction(dmId, messageId, emoji) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-reaction",
      dmId,
      messageId,
      emoji,
    });
    if (!r.ok) {
      this.hooks.onError(r.error || "Reaction failed");
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (other) {
      this._send(
        encodeFrame("dm-reaction", { dmId, messageId, emoji }),
        other,
      );
    }
    this.hooks.onChange();
  }

  /**
   * Group → group forward via host.
   * @param {string} fromChatId
   * @param {string} messageId
   * @param {string} toChatId
   * @param {string} [fromName]
   */
  forwardGroupMessage(fromChatId, messageId, toChatId, fromName) {
    this.dispatchHostAction({
      type: "forward-message",
      fromChatId,
      messageId,
      toChatId,
      fromName,
    });
  }

  /**
   * Send a pre-built forwarded message into a DM (targeted).
   * @param {string} dmId
   * @param {import("./engine.js").Message} message
   */
  forwardToDm(dmId, message) {
    const r = applyDm(this.dmState, this.selfPeerId, {
      type: "dm-forward",
      dmId,
      message,
    });
    if (!r.ok || !r.message) {
      this.hooks.onError(r.error || "Forward failed");
      return;
    }
    this.dmState = r.state;
    const other = this._dmOther(dmId);
    if (other) {
      this._send(
        encodeFrame("dm-forward", { dmId, message: r.message }),
        other,
      );
    }
    this.hooks.onChange();
  }

  /** @param {string} title */
  renameSession(title) {
    this.dispatchHostAction({ type: "admin-rename-session", title });
  }

  /** @param {string} peerId */
  kickPeer(peerId) {
    this.dispatchHostAction({ type: "admin-kick", peerId });
  }

  endSession() {
    this.dispatchHostAction({ type: "admin-end-session" });
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
    const cfg = roomConfig(this._password);
    const topic = await deriveTopic(sessionId, this._password);
    log("room", "joinRoom", {
      sessionId,
      role: this.role,
      appId: cfg.appId,
      hasPassword: Boolean(this._password),
      iceServers: cfg.rtcConfig?.iceServers?.map((s) => s.urls),
      turnCount: cfg.turnConfig?.length || 0,
    });
    const room = joinRoom(cfg, topic, {
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
      if (this.role === "candidate") {
        this._candidateIds.add(peerId);
        this._sendRoomPresence(peerId);
      }
      if (
        this.role === "guest" &&
        (!this.hostState || this._hostGraceTimer)
      ) {
        log("guest", "hello → peer join", peerId, {
          grace: Boolean(this._hostGraceTimer),
        });
        this._sendHello(this._hostHint || peerId).catch((err) =>
          logError("guest", "rehello failed", err),
        );
        if (this._hostGraceTimer) this._startHelloRetry();
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    room.onPeerLeave = (peerId) => {
      log("peer", "leave", peerId);
      this.connectedPeers.delete(peerId);
      this._candidateIds.delete(peerId);
      this._awaitingHello.delete(peerId);
      if (this.role === "host" && this.hostState) {
        // Soft-offline only — keep roster membership and all groups/chats.
        if (this.hostState.roster.some((r) => r.peerId === peerId)) {
          this.hostState = setRosterOnline(this.hostState, peerId, false);
          this.hostState = bumpHostRevision(this.hostState);
          this._broadcastRoster();
          this.hooks.onChange();
        }
      }
      if (this.role === "guest" && this.hostState) {
        const hostId = this._hostHint || getHostPeerId(this.hostState);
        if (peerId === hostId) {
          this.hostState = setRosterOnline(this.hostState, peerId, false);
          if (this.roomMode === "permanent") {
            this._permanentHostMissing = true;
            this.hooks.onStatus("Host reconnecting (30s)");
          } else {
            // Random-session host may be refreshing — wait briefly before ending.
            this._startHostGrace();
          }
        }
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    room.onPathChange = () => {
      if (
        this.roomMode === "permanent" &&
        this.role === "guest" &&
        this._hostHint
      ) {
        this._permanentHostMissing =
          !room.isPeerReachable?.(this._hostHint);
      }
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
    };

    this._startDiag();
  }

  _clearHostGrace() {
    if (this._hostGraceTimer) {
      clearTimeout(this._hostGraceTimer);
      this._hostGraceTimer = null;
    }
  }

  _startHostGrace() {
    this._clearHostGrace();
    this.hooks.onStatus("Host reconnecting…");
    this._hostGraceTimer = setTimeout(() => {
      this._hostGraceTimer = null;
      if (!this.sessionEnded) {
        this._endSessionLocal("Host left");
        this.hooks.onChange();
      }
    }, 20_000);
  }

  _clearElectionTimers() {
    clearTimeout(this._electionTimer);
    clearTimeout(this._hostLeaseTimer);
    clearInterval(this._hostClaimTimer);
    this._electionTimer = null;
    this._hostLeaseTimer = null;
    this._hostClaimTimer = null;
  }

  _sendRoomPresence(target) {
    if (this.roomMode !== "permanent" || !this._chat) return;
    this._send(
      encodeRoomControlFrame("room-presence", {
        roomId: this.permanentRoomId,
        candidateId: this.selfPeerId,
        term: this.electionTerm,
        hostId: this.role === "host" ? this.selfPeerId : this._hostHint || "",
        role: this.role,
      }),
      target,
    );
  }

  _scheduleElection(delay = 3_000, replacement = false) {
    clearTimeout(this._electionTimer);
    const epoch = ++this._electionEpoch;
    this.hooks.onStatus(replacement ? "Electing host" : "Looking for room");
    this._electionTimer = setTimeout(() => {
      if (epoch !== this._electionEpoch || this.role !== "candidate") return;
      this._runElection(replacement);
    }, delay);
  }

  _runElection(replacement) {
    if (this.role !== "candidate") return;
    if (replacement) this.electionTerm += 1;
    else this.electionTerm = Math.max(1, this.electionTerm);
    this._candidateIds.add(this.selfPeerId);
    const winner = pickElectionWinner(this._candidateIds);
    this.hooks.onStatus("Electing host");
    if (winner === this.selfPeerId) {
      this._becomePermanentHost(replacement || Boolean(this.hostState));
      return;
    }
    // The deterministic winner should claim shortly; retry if it vanished.
    this._scheduleElection(2_500, false);
  }

  _becomePermanentHost(reconstruct) {
    this.role = "host";
    this._hostHint = this.selfPeerId;
    this._candidateIds.clear();
    this._permanentHostMissing = false;
    clearTimeout(this._electionTimer);
    clearTimeout(this._hostLeaseTimer);
    this._electionTimer = null;
    this._hostLeaseTimer = null;
    this.ended = false;

    if (!reconstruct) {
      this.hostState = createHostState({
        sessionId: this._sessionId,
        title: this.permanentRoomId,
        hostPeer: {
          peerId: this.selfPeerId,
          displayName: this._pendingDisplayName || "Host",
          role: "host",
          joinedAt: Date.now(),
          colorIndex: 0,
        },
      });
      this.hostState.meta = {
        ...(this.hostState.meta || {}),
        revision: 0,
        groupRevisions: {},
      };
      this._continuing = false;
      this._startHostClaims();
      this._sendHostClaim();
      this.hooks.onStatus(this._statusLabel());
      this.hooks.onChange();
      return;
    }

    this._continuing = true;
    this._stateOffers = new Map();
    if (this.hostState) this._stateOffers.set(this.selfPeerId, this.hostState);
    this._startHostClaims();
    this._sendHostClaim();
    this._send(
      encodeRoomControlFrame("state-handoff-request", {
        term: this.electionTerm,
        hostId: this.selfPeerId,
      }),
    );
    this.hooks.onStatus("Continuing with new host");
    setTimeout(() => this._finishStateHandoff(), 1_500);
  }

  _finishStateHandoff() {
    if (this.role !== "host" || !this._continuing) return;
    this.hostState = mergeHostSnapshots([...this._stateOffers.values()], {
      sessionId: this._sessionId,
      title: this.permanentRoomId,
      hostPeerId: this.selfPeerId,
      hostDisplayName: this._pendingDisplayName || "Host",
      hostTrip: this._handle || undefined,
      activePeerIds: [...this._stateOffers.keys()],
    });
    this._continuing = false;
    this._broadcastRoster();
    for (const peerId of this.connectedPeers) {
      this._send(encodeFrame("hello-request", {}), peerId);
    }
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
  }

  _startHostClaims() {
    clearInterval(this._hostClaimTimer);
    this._hostClaimTimer = setInterval(() => this._sendHostClaim(), 7_000);
    this.leaseExpiry = Date.now() + HOST_GRACE_MS;
  }

  _sendHostClaim(target) {
    if (this.roomMode !== "permanent" || this.role !== "host") return;
    this.leaseExpiry = Date.now() + HOST_GRACE_MS;
    this._send(
      encodeRoomControlFrame("host-claim", {
        roomId: this.permanentRoomId,
        hostId: this.selfPeerId,
        term: this.electionTerm,
        leaseExpiry: this.leaseExpiry,
        revision: Number(this.hostState?.meta?.revision) || 0,
      }),
      target,
    );
    if (!target) this.hooks.onChange();
  }

  _acceptHostClaim(hostId, term) {
    const previousHost =
      this._hostHint || (this.hostState ? getHostPeerId(this.hostState) : "");
    const wasHost = this.role === "host";
    if (wasHost && hostId !== this.selfPeerId && this.hostState) {
      this._send(
        encodeRoomControlFrame("state-handoff", {
          term,
          from: this.selfPeerId,
          state: this.hostState,
        }),
        hostId,
      );
    }
    if (wasHost) clearInterval(this._hostClaimTimer);
    this.role = "guest";
    this.electionTerm = term;
    this._hostHint = hostId;
    this._permanentHostMissing = false;
    this._continuing = false;
    clearTimeout(this._electionTimer);
    this._candidateIds.clear();
    this._scheduleHostLease();
    if (previousHost !== hostId || !this.hostState) {
      this._sendHello(hostId).catch((err) =>
        logError("guest", "host-claim hello failed", err),
      );
      this._startHelloRetry();
    }
    this.hooks.onStatus(this._statusLabel());
    this.hooks.onChange();
  }

  _scheduleHostLease() {
    clearTimeout(this._hostLeaseTimer);
    this.leaseExpiry = Date.now() + HOST_GRACE_MS;
    this._hostLeaseTimer = setTimeout(() => {
      if (this.roomMode !== "permanent" || this.role !== "guest") return;
      this.role = "candidate";
      this._permanentHostMissing = true;
      this._candidateIds = new Set([this.selfPeerId, ...this.connectedPeers]);
      this._scheduleElection(250, true);
      this.hooks.onChange();
    }, HOST_GRACE_MS);
  }

  _onElectionFrame(type, body, peerId) {
    if (this.roomMode !== "permanent") return false;
    if (type === "room-presence") {
      if (body.roomId !== this.permanentRoomId) return true;
      this._candidateIds.add(peerId);
      if (this.role === "host") this._sendHostClaim(peerId);
      else if (body.role === "host" && body.hostId === peerId) {
        this._sendRoomPresence(peerId);
      }
      return true;
    }

    if (type === "host-claim") {
      const term = Number(body.term);
      const hostId = String(body.hostId || "");
      if (
        body.roomId !== this.permanentRoomId ||
        hostId !== peerId ||
        !Number.isInteger(term) ||
        term < 1
      ) {
        return true;
      }
      const currentHost =
        this.role === "host" ? this.selfPeerId : this._hostHint || "";
      const superior =
        compareHostClaims(
          { term, hostId },
          { term: this.electionTerm, hostId: currentHost },
        ) > 0;
      if (hostId === currentHost && term === this.electionTerm) {
        if (this.role === "guest") {
          this._permanentHostMissing = false;
          this._scheduleHostLease();
          this.hooks.onChange();
        }
        return true;
      }
      if (superior) {
        this._acceptHostClaim(hostId, term);
      } else if (this.role === "host") {
        this._sendHostClaim(peerId);
      }
      return true;
    }

    if (type === "state-handoff-request") {
      if (
        body.hostId === peerId &&
        Number(body.term) >= this.electionTerm &&
        this.hostState
      ) {
        this._send(
          encodeRoomControlFrame("state-handoff", {
            term: Number(body.term),
            from: this.selfPeerId,
            state: this.hostState,
          }),
          peerId,
        );
      }
      return true;
    }

    if (type === "state-handoff") {
      if (
        this.role === "host" &&
        this._continuing &&
        Number(body.term) === this.electionTerm &&
        body.from === peerId &&
        body.state
      ) {
        this._stateOffers.set(peerId, body.state);
      }
      return true;
    }
    return false;
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

    if (
      isRoomControlFrame(type) &&
      this._onElectionFrame(type, body, peerId)
    ) {
      return;
    }

    if (String(type).startsWith("media-")) {
      this._onMediaFrame(type, body, peerId);
      return;
    }

    if (String(type).startsWith("sticker-") || String(type).startsWith("pack-")) {
      this._onStickerFrame(type, body, peerId);
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
      this._awaitingHello.delete(peerId);
      this._handleHello(body, peerId).catch((err) =>
        logError("host", "hello failed", err),
      );
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
      this.hostState = bumpHostRevision(result.state, action);
      this._emitEffects(result.effects, false);
      this._ackFromEffects(result.effects);
      if (action.type === "admin-kick" && action.peerId) {
        this._broadcastRoster();
        this._send(
          encodeFrame("peer-kicked", {
            peerId: action.peerId,
            reason: "kicked",
          }),
          action.peerId,
        );
      }
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
      type === "dm-delete" ||
      type === "dm-reaction" ||
      type === "dm-forward"
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
    const hostFrame =
      type === "hello-request" ||
      type === "welcome" ||
      type === "roster" ||
      type === "event" ||
      type === "state" ||
      type === "error" ||
      type === "session-ended" ||
      type === "peer-kicked" ||
      type === "peer-remap";
    if (type === "welcome") {
      this._hostHint = peerId;
    }
    if (hostFrame && this._hostHint && peerId !== this._hostHint) {
      warn("guest", "ignore host frame from non-host", type, peerId);
      return;
    }

    if (type === "hello-request") {
      log("guest", "hello-request from", peerId);
      // Always answer — host may have refreshed while we still hold hostState.
      this._sendHello(peerId).catch((err) =>
        logError("guest", "hello-request reply failed", err),
      );
      return;
    }

    if (type === "peer-remap") {
      const oldPeerId = String(body.oldPeerId || "").trim();
      const newPeerId = String(body.newPeerId || "").trim();
      this._applyPeerRemap(oldPeerId, newPeerId);
      return;
    }

    if (type === "welcome") {
      const state = body.state;
      if (!state || typeof state !== "object") {
        warn("guest", "welcome missing state", body);
        return;
      }
      this._hostHint = peerId;
      this._clearHostGrace();
      if (this.roomMode === "permanent") this._scheduleHostLease();
      this.ended = false;
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

    if (type === "peer-kicked") {
      const kicked = String(body.peerId || "").trim();
      if (kicked === this.selfPeerId) {
        this._stopHelloRetry();
        this._endSessionLocal("You were removed from the session");
        this.hooks.onError("You were removed from the session");
      } else if (this.hostState) {
        this.hostState = {
          ...this.hostState,
          roster: this.hostState.roster.filter((r) => r.peerId !== kicked),
        };
        this.hooks.onChange();
      }
      return;
    }

    if (
      type === "dm-open" ||
      type === "dm-send-text" ||
      type === "dm-send-sticker" ||
      type === "dm-send-media" ||
      type === "dm-edit" ||
      type === "dm-ack" ||
      type === "dm-delete" ||
      type === "dm-reaction" ||
      type === "dm-forward"
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
      return;
    }

    if (type === "dm-reaction") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-reaction",
          dmId,
          messageId: body.messageId,
          emoji: body.emoji,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        this.hooks.onChange();
      }
      return;
    }

    if (type === "dm-forward") {
      const r = applyDm(
        this.dmState,
        this.selfPeerId,
        {
          type: "dm-forward",
          dmId,
          message: body.message,
        },
        { remoteSenderPeerId: peerId },
      );
      if (r.ok) {
        this.dmState = r.state;
        if (r.message) {
          this.rememberMediaInfo(r.message);
          if (r.message.mediaIds?.length) {
            const sizes = Object.create(null);
            const mimes = Object.create(null);
            const senders = Object.create(null);
            r.message.mediaIds.forEach((id, i) => {
              const sz = r.message.mediaInfo?.[i]?.size;
              if (sz != null) sizes[id] = sz;
              const mime = r.message.mediaInfo?.[i]?.mime;
              if (mime) mimes[id] = mime;
              if (r.message.senderPeerId) senders[id] = r.message.senderPeerId;
              // Prefer original media sender from forward meta if present in local store
              const meta = this._mediaMeta.get(id);
              if (meta?.senderPeerId) senders[id] = meta.senderPeerId;
            });
            this.ensureMedia(r.message.mediaIds, { sizes, mimes, senders });
          }
          this._send(
            encodeFrame("dm-ack", { dmId, messageIds: [r.message.id] }),
            peerId,
          );
        }
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
        this.hostState = bumpHostRevision(result.state, {
          chatId,
        });
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
      const versionedEffect = {
        ...effect,
        revision: Number(this.hostState.meta?.revision) || 0,
        groupRevision: effect.chatId
          ? Number(this.hostState.meta?.groupRevisions?.[effect.chatId]) || 0
          : undefined,
      };
      if (effect.event === "session-ended") continue;
      // peer-kicked is sent as a dedicated frame to the kickee; roster broadcast separate.
      if (effect.event === "peer-kicked") {
        const wireTargets = [...this.connectedPeers].filter(
          (id) => id && id !== this.selfPeerId && id !== effect.peerId,
        );
        this._sendToPeers(encodeFrame("event", versionedEffect), wireTargets);
        continue;
      }

      let targets = [];
      if (effect.event === "chat-deleted" && effect.memberPeerIds) {
        targets = [...effect.memberPeerIds];
      } else if (effect.event === "chat-created" && effect.chat) {
        targets = [...effect.chat.memberPeerIds];
      } else if (effect.event === "session-renamed") {
        targets = [...this.connectedPeers];
      } else if (effect.chatId && this.hostState.groups[effect.chatId]) {
        targets = fanoutPeerIdsForGroup(this.hostState, effect.chatId);
      } else {
        targets = [...this.connectedPeers];
      }
      if (hostId) targets.push(hostId);

      const wireTargets = [...new Set(targets)].filter(
        (id) => id && id !== this.selfPeerId,
      );
      this._sendToPeers(encodeFrame("event", versionedEffect), wireTargets);
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
      if (offerSize && !mediaId.startsWith("st:")) {
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
      if (wasMissing && !mediaId.startsWith("st:")) {
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

  /** UI reports the sticker site is reachable (an <img> loaded from it). */
  markStickerSiteReachable() {
    this._stickerSiteReachable = true;
  }

  /**
   * Peer-relay fallback for stickers when the sticker site is unreachable here.
   * Tries the original sender first, then any peer with site access. The actual
   * bytes ride the encrypted media-* transport keyed by a synthetic `st:` id.
   * @param {string} pack @param {string} stickerId @param {string} [fromPeerId]
   */
  requestSticker(pack, stickerId, fromPeerId) {
    if (!pack || !stickerId) return;
    const stId = stickerMediaId(pack, stickerId);
    if (this._stickerPulls.has(stId)) return; // already in flight
    const pull = {
      pack,
      stickerId,
      tried: /** @type {Set<string>} */ (new Set()),
      broadcastTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
      giveUpTimer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
    };
    this._stickerPulls.set(stId, pull);
    this._fetching.add(stId); // authorise the incoming media-offer for this id
    const target =
      fromPeerId && fromPeerId !== this.selfPeerId ? fromPeerId : null;
    if (target) {
      pull.tried.add(target);
      this._send(encodeFrame("sticker-request", { pack, stickerId }), target);
      pull.broadcastTimer = setTimeout(
        () => this._broadcastStickerNeed(stId),
        2500,
      );
    } else {
      this._broadcastStickerNeed(stId);
    }
    pull.giveUpTimer = setTimeout(() => this._endStickerPull(stId), 30_000);
  }

  /**
   * Ask a peer (usually the sticker's sender) for a pack's JSON so it can be
   * cached and rendered without reaching the sticker site.
   * @param {string} pack @param {string} fromPeerId
   */
  requestPack(pack, fromPeerId) {
    if (!pack || !fromPeerId || fromPeerId === this.selfPeerId) return;
    this._send(encodeFrame("pack-request", { pack }), fromPeerId);
  }

  /** @param {string} stId */
  _broadcastStickerNeed(stId) {
    const pull = this._stickerPulls.get(stId);
    if (!pull) return;
    this._send(
      encodeFrame("sticker-availability", {
        pack: pull.pack,
        stickerId: pull.stickerId,
      }),
    );
  }

  /** @param {string} stId */
  _endStickerPull(stId) {
    const pull = this._stickerPulls.get(stId);
    if (!pull) return;
    if (pull.broadcastTimer) clearTimeout(pull.broadcastTimer);
    if (pull.giveUpTimer) clearTimeout(pull.giveUpTimer);
    this._stickerPulls.delete(stId);
    this._fetching.delete(stId);
  }

  /**
   * Handle sticker/pack relay control frames (both host and guest roles).
   * @param {string} type @param {object} body @param {string} peerId
   */
  async _onStickerFrame(type, body, peerId) {
    const pack = String(body.pack || "").trim();
    const stickerId = String(body.stickerId || "").trim();

    if (type === "sticker-request") {
      if (!pack || !stickerId) return;
      const stId = stickerMediaId(pack, stickerId);
      let blob = await getStickerBlob(pack, stickerId);
      if (!blob) {
        try {
          blob = await fetchStickerBytes(pack, stickerId);
          this._stickerSiteReachable = true;
          await putSticker(pack, stickerId, blob);
        } catch {
          this._send(
            encodeFrame("sticker-reject", { pack, stickerId }),
            peerId,
          );
          return;
        }
      }
      log("sticker", "serve", stId, "→", peerId, blob.size);
      this._sendMediaChunks(peerId, stId, blob, {
        mime: blob.type || "image/webp",
        size: blob.size,
      }).catch((e) => logError("sticker", "serve failed", e));
      return;
    }

    if (type === "sticker-reject") {
      const stId = stickerMediaId(pack, stickerId);
      if (this._stickerPulls.has(stId)) this._broadcastStickerNeed(stId);
      return;
    }

    if (type === "sticker-availability") {
      if (!pack || !stickerId || peerId === this.selfPeerId) return;
      const have = Boolean(await getStickerBlob(pack, stickerId));
      if (have || this._stickerSiteReachable) {
        this._send(
          encodeFrame("sticker-available", { pack, stickerId }),
          peerId,
        );
      }
      return;
    }

    if (type === "sticker-available") {
      const stId = stickerMediaId(pack, stickerId);
      const pull = this._stickerPulls.get(stId);
      if (!pull || pull.tried.has(peerId)) return;
      pull.tried.add(peerId); // take the first responder
      this._send(encodeFrame("sticker-request", { pack, stickerId }), peerId);
      return;
    }

    if (type === "pack-request") {
      if (!pack) return;
      const local = getPack(pack);
      if (local?.stickers?.length) {
        this._send(encodeFrame("pack-data", { pack, json: local }), peerId);
      } else {
        this._send(encodeFrame("pack-reject", { pack }), peerId);
      }
      return;
    }

    if (type === "pack-data") {
      if (!pack || !body.json || typeof body.json !== "object") return;
      try {
        upsertPack(normalizePackJson(pack, body.json));
      } catch (e) {
        warn("sticker", "bad pack-data", e);
        return;
      }
      this.hooks.onPackData?.(pack);
      this.hooks.onChange();
      return;
    }

    if (type === "pack-reject") {
      this.hooks.onPackUnavailable?.(pack);
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

      if (mediaId.startsWith(STICKER_MEDIA_PREFIX)) {
        const { pack, stickerId } = parseStickerMediaId(mediaId);
        putSticker(pack, stickerId, blob)
          .then(() => this.hooks.onChange())
          .catch((e) => warn("sticker", "cache write failed", e));
        this._endStickerPull(mediaId);
        this._incoming.delete(mediaId);
        this._send(
          encodeFrame("media-complete", { mediaId, ok: true }),
          peerId,
        );
        log("sticker", "cached from peer", mediaId, blob.size, `${total} chunks`);
        return true;
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
        isDeferredTransferMime(entry.mime) &&
        isDeferredPlayableSize(entry.size);
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
   * Accept a hello: soft rejoin, continuity/trip remap, then welcome.
   * @param {object} body
   * @param {string} peerId
   */
  async _handleHello(body, peerId) {
    if (!this.hostState) return;
    log("host", "hello from", peerId, body);
    if (body.app !== APP_ID) {
      warn("host", "app mismatch", body.app);
      this._send(encodeFrame("error", { message: "App mismatch" }), peerId);
      return;
    }
    if (body.version !== APP_VERSION) {
      warn("host", "version mismatch", body.version, "expected", APP_VERSION);
      this._send(encodeFrame("error", { message: "Version mismatch" }), peerId);
      return;
    }

    const displayName = String(body.displayName || "").trim() || "Guest";
    const trip = body.trip || undefined;
    const contOk = await verifyContinuity(peerId, body.cont);
    const contPub = contOk ? continuityPubKey(body.cont) : "";
    const tripOk = trip ? await verifyHandle(peerId, trip) : false;

    let remappedFrom = "";
    const already = this.hostState.roster.some((r) => r.peerId === peerId);
    if (already) {
      this.hostState = addRosterPeer(this.hostState, {
        peerId,
        displayName,
        trip,
        contPub: contPub || undefined,
        online: true,
      });
    } else {
      let match = null;
      if (contPub) {
        match = this.hostState.roster.find(
          (r) => r.contPub && r.contPub === contPub && r.peerId !== peerId,
        );
      }
      if (!match && tripOk && trip?.id) {
        match = this.hostState.roster.find(
          (r) => r.trip?.id === trip.id && r.peerId !== peerId,
        );
      }
      if (match) {
        remappedFrom = match.peerId;
        this.hostState = remapRosterPeer(
          this.hostState,
          remappedFrom,
          peerId,
          {
            displayName,
            trip: tripOk ? trip : match.trip,
            contPub: contPub || match.contPub,
            online: true,
          },
        );
        this._applyPeerRemap(remappedFrom, peerId);
        this._send(encodeFrame("peer-remap", { oldPeerId: remappedFrom, newPeerId: peerId }));
        log("host", "remapped peer", remappedFrom, "→", peerId, {
          via: contPub ? "continuity" : "trip",
        });
      } else {
        this.hostState = addRosterPeer(this.hostState, {
          peerId,
          displayName,
          trip,
          contPub: contPub || undefined,
          online: true,
        });
      }
    }

    this.hostState = bumpHostRevision(this.hostState);
    const filtered = filterHostStateForPeer(this.hostState, peerId);
    log("host", "welcome →", peerId, {
      title: this.hostState.session?.title,
      roster: this.hostState.roster.length,
      remappedFrom: remappedFrom || undefined,
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
  }

  /**
   * Rewrite local DM keys when a peer identity is remapped.
   * @param {string} oldPeerId
   * @param {string} newPeerId
   */
  _applyPeerRemap(oldPeerId, newPeerId) {
    if (!oldPeerId || !newPeerId || oldPeerId === newPeerId) return;
    this.dmState = remapDmPeer(this.dmState, oldPeerId, newPeerId);
    // Guests also rewrite hostState locally if they still hold a stale copy
    // before welcome; host already remapped via remapRosterPeer.
    if (this.role !== "host" && this.hostState) {
      this.hostState = remapRosterPeer(this.hostState, oldPeerId, newPeerId, {
        online: true,
      });
    }
    this.hooks.onChange();
  }

  /**
   * @param {string} [targetPeerId]
   */
  async _sendHello(targetPeerId) {
    const displayName = this._pendingDisplayName || "Guest";
    const cont = this._continuity
      ? await claimContinuity(this._continuity, this.selfPeerId)
      : null;
    log("guest", "send hello", { targetPeerId: targetPeerId || "*", displayName });
    this._send(
      encodeFrame("hello", {
        app: APP_ID,
        version: APP_VERSION,
        displayName,
        trip: this._handle || undefined,
        cont: cont || undefined,
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
        this._sendHello(this._hostHint || undefined).catch((err) =>
          logError("guest", "hello retry failed", err),
        );
      } else {
        log(
          "guest",
          "still no WebRTC peers — MQTT/Nostr discovery or ICE may be failing",
        );
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
    if (this._continuing) return "Continuing with new host";
    if (this.roomMode === "permanent" && this.role === "candidate") {
      return this._permanentHostMissing ? "Electing host" : "Looking for room";
    }
    if (this.roomMode === "permanent" && this._permanentHostMissing) {
      return "Host reconnecting (30s)";
    }
    if (this._hostGraceTimer) return "Host reconnecting…";
    if (this.role === "guest" && !this.hostState) {
      if (this.connectedPeers.size === 0) {
        return "Looking for host over MQTT + Nostr…";
      }
      return "Peer path found · routing to host…";
    }
    const n = this.hostState?.roster?.length || 1;
    if (this.role === "host" && n <= 1 && this.connectedPeers.size === 0) {
      return "Online · waiting for guests";
    }
    const paths = this._room?.getPathSummary?.();
    if (paths?.indirect) {
      return `Connected (${n}) · relaying for ${paths.indirect}`;
    }
    if (paths?.mqtt && paths?.nostr) {
      return `Connected (${n}) · MQTT + Nostr`;
    }
    if (paths?.nostr) return `Connected (${n}) · Nostr`;
    if (paths?.mqtt) return `Connected (${n}) · MQTT`;
    return `Connected (${n})`;
  }
}

/**
 * @param {Blob[]} files
 * @returns {{ files: Blob[], mediaKind: "image" | "video" | "audio" | "file" }}
 */
function classifyMediaBatch(files) {
  if (!files?.length) throw new Error("No media files");
  const videos = files.filter((f) => f.type.startsWith("video/"));
  const images = files.filter((f) => f.type.startsWith("image/"));
  const audios = files.filter((f) => f.type.startsWith("audio/"));
  const docs = files.filter(
    (f) =>
      !f.type.startsWith("video/") &&
      !f.type.startsWith("image/") &&
      !f.type.startsWith("audio/"),
  );
  const kinds =
    (videos.length ? 1 : 0) +
    (images.length ? 1 : 0) +
    (audios.length ? 1 : 0) +
    (docs.length ? 1 : 0);
  if (kinds > 1) {
    throw new Error("Cannot mix photos, video, audio, and files in one send");
  }
  if (videos.length > 1) {
    throw new Error("Send one video at a time");
  }
  if (audios.length > 1) {
    throw new Error("Send one audio at a time");
  }
  if (docs.length > 1) {
    throw new Error("Send one file at a time");
  }
  if (videos.length === 1) {
    return { files: [videos[0]], mediaKind: "video" };
  }
  if (audios.length === 1) {
    return { files: [audios[0]], mediaKind: "audio" };
  }
  if (docs.length === 1) {
    return { files: [docs[0]], mediaKind: "file" };
  }
  if (images.length > MAX_ALBUM_ITEMS) {
    throw new Error(`Album max ${MAX_ALBUM_ITEMS} images`);
  }
  return { files: images, mediaKind: "image" };
}

/** Synthetic media id prefix used to route sticker byte transfers to the cache. */
const STICKER_MEDIA_PREFIX = "st:";

/**
 * Pack names are [A-Za-z0-9_]+ so "/" is a safe separator from the sticker id.
 * @param {string} pack @param {string} stickerId
 */
function stickerMediaId(pack, stickerId) {
  return `${STICKER_MEDIA_PREFIX}${pack}/${stickerId}`;
}

/** @param {string} id @returns {{ pack: string, stickerId: string }} */
function parseStickerMediaId(id) {
  const rest = id.slice(STICKER_MEDIA_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash < 0
    ? { pack: rest, stickerId: "" }
    : { pack: rest.slice(0, slash), stickerId: rest.slice(slash + 1) };
}

/**
 * Coerce a peer-relayed pack payload into the local StickerPack shape.
 * @param {string} pack @param {any} json
 */
function normalizePackJson(pack, json) {
  const stickers = Array.isArray(json.stickers) ? json.stickers : [];
  return {
    name: String(json.name || pack),
    title: String(json.title || pack),
    stickers: stickers.map((s) => ({
      id: String(s.id),
      emoji: s.emoji || "",
      file_url: String(s.file_url || ""),
      thumbnail_url: String(s.thumbnail_url || ""),
    })),
    addedAt: Date.now(),
  };
}
