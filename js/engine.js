import { APP_ID, APP_VERSION, MAX_ALBUM_ITEMS } from "./constants.js";
import { dmIdFor, mintId } from "./ids.js";
import { sanitizeFileName } from "./media.js";

/**
 * @typedef {{
 *   peerId: string,
 *   displayName: string,
 *   role: "host" | "member",
 *   joinedAt: number,
 *   colorIndex?: number,
 *   trip?: object,
 *   contPub?: string,
 *   online?: boolean,
 * }} RosterEntry
 * @typedef {"private" | "public" | "everyone"} GroupMode
 * @typedef {{
 *   id: string,
 *   type: "dm" | "group",
 *   title?: string,
 *   memberPeerIds: string[],
 *   createdBy: string,
 *   createdAt: number,
 *   mode?: GroupMode,
 * }} Chat
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   senderPeerId: string,
 *   createdAt: number,
 *   editedAt?: number,
 *   kind: "text" | "sticker" | "media" | "album" | "video" | "audio" | "file" | "system",
 *   text?: string,
 *   entities?: { type: string, offset: number, length: number, url?: string }[],
 *   replyTo?: string,
 *   forward?: { fromName: string, fromPeerId?: string, originalId?: string, fromChatId?: string },
 *   reactions?: { emoji: string, peerIds: string[] }[],
 *   delivery?: { ackedBy: string[] },
 *   sticker?: { pack: string, stickerId: string },
 *   mediaIds?: string[],
 *   mediaInfo?: { size: number, mime?: string, duration?: number, width?: number, height?: number, fileName?: string, thumbDataUrl?: string }[],
 * }} Message
 * @typedef {{
 *   app: string,
 *   version: number,
 *   session: { id: string, title?: string, ended: boolean, createdAt: number },
 *   roster: RosterEntry[],
 *   groups: Record<string, Chat>,
 *   groupMessages: Record<string, Message[]>,
 *   meta: Record<string, unknown>,
 * }} HostState
 * @typedef {{
 *   dms: Record<string, Chat>,
 *   dmMessages: Record<string, Message[]>,
 * }} DmState
 * @typedef {{ event: string, chatId?: string, chat?: Chat, messages?: Message[], message?: Message, messageId?: string, memberPeerIds?: string[], delivery?: { ackedBy: string[] } }} Effect
 */

/**
 * @param {{ sessionId: string, title?: string, hostPeer: RosterEntry }} opts
 * @returns {HostState}
 */
export function createHostState({ sessionId, title, hostPeer }) {
  const now = Date.now();
  return {
    app: APP_ID,
    version: APP_VERSION,
    session: {
      id: sessionId,
      title: title || "Session",
      ended: false,
      createdAt: now,
    },
    roster: [hostPeer],
    groups: {},
    groupMessages: {},
    meta: { revision: 0, groupRevisions: {} },
  };
}

/** @returns {DmState} */
export function createEmptyDmState() {
  return { dms: {}, dmMessages: {} };
}

/**
 * Deep-clone host state for welcome / broadcast. Must never include DM keys.
 * @param {HostState} state
 * @returns {HostState}
 */
export function hostSnapshot(state) {
  const snap = JSON.parse(JSON.stringify(state));
  if ("dms" in snap || "dmMessages" in snap) {
    throw new Error("hostSnapshot leaked DM keys");
  }
  return snap;
}

/** @param {HostState} state @returns {string | null} */
export function getHostPeerId(state) {
  return state.roster.find((r) => r.role === "host")?.peerId ?? null;
}

/** @param {HostState} state @param {string} peerId */
export function isHostPeer(state, peerId) {
  return getHostPeerId(state) === peerId;
}

/** @param {Chat | undefined | null} chat @returns {GroupMode} */
export function groupModeOf(chat) {
  const m = chat?.mode;
  if (m === "public" || m === "everyone") return m;
  return "private";
}

/**
 * Groups + messages visible to a peer. Host admin sees all groups.
 * Public groups are visible to non-members as metadata-only stubs (no messages).
 * @param {HostState} state
 * @param {string} peerId
 * @returns {HostState}
 */
export function filterHostStateForPeer(state, peerId) {
  const snap = hostSnapshot(state);
  if (isHostPeer(snap, peerId)) return snap;

  /** @type {Record<string, Chat>} */
  const groups = {};
  /** @type {Record<string, Message[]>} */
  const groupMessages = {};
  for (const [id, chat] of Object.entries(snap.groups)) {
    const member = chat.memberPeerIds.includes(peerId);
    if (member) {
      groups[id] = chat;
      groupMessages[id] = snap.groupMessages[id] || [];
      continue;
    }
    if (groupModeOf(chat) === "public") {
      groups[id] = chat;
      groupMessages[id] = [];
    }
  }
  return { ...snap, groups, groupMessages };
}

/**
 * @param {HostState} state
 * @param {Omit<RosterEntry, "joinedAt" | "colorIndex" | "role"> & { role?: "member", colorIndex?: number, online?: boolean, contPub?: string }} peer
 * @returns {HostState}
 */
export function addRosterPeer(state, peer) {
  const next = clone(state);
  const idx = next.roster.findIndex((r) => r.peerId === peer.peerId);
  if (idx >= 0) {
    const prev = next.roster[idx];
    next.roster[idx] = {
      ...prev,
      displayName: peer.displayName || prev.displayName,
      trip: peer.trip !== undefined ? peer.trip : prev.trip,
      contPub: peer.contPub !== undefined ? peer.contPub : prev.contPub,
      online: peer.online !== undefined ? peer.online : true,
    };
    return next;
  }
  next.roster.push({
    peerId: peer.peerId,
    displayName: peer.displayName,
    role: "member",
    joinedAt: Date.now(),
    colorIndex: peer.colorIndex ?? nextColorIndex(next),
    trip: peer.trip || undefined,
    contPub: peer.contPub || undefined,
    online: peer.online !== undefined ? peer.online : true,
  });
  return next;
}

/**
 * Soft presence flip — does not touch groups or membership.
 * @param {HostState} state
 * @param {string} peerId
 * @param {boolean} online
 * @returns {HostState}
 */
export function setRosterOnline(state, peerId, online) {
  if (!rosterHas(state, peerId)) return state;
  const next = clone(state);
  next.roster = next.roster.map((r) =>
    r.peerId === peerId ? { ...r, online: Boolean(online) } : r,
  );
  return next;
}

/**
 * Hard-remove a peer from the roster and group memberships (admin-kick).
 * Never deletes groups — only kebab Delete group does that.
 * @param {HostState} state
 * @param {string} peerId
 * @returns {HostState}
 */
export function removeRosterPeer(state, peerId) {
  if (isHostPeer(state, peerId)) return state;
  const next = clone(state);
  next.roster = next.roster.filter((r) => r.peerId !== peerId);
  for (const chat of Object.values(next.groups)) {
    chat.memberPeerIds = chat.memberPeerIds.filter((p) => p !== peerId);
  }
  return next;
}

/**
 * Rewrite a peerId across roster, groups, and messages (continuity / trip remap).
 * @param {HostState} state
 * @param {string} oldPeerId
 * @param {string} newPeerId
 * @param {{ displayName?: string, trip?: object, contPub?: string, online?: boolean }} [patch]
 * @returns {HostState}
 */
export function remapRosterPeer(state, oldPeerId, newPeerId, patch = {}) {
  if (!state || !oldPeerId || !newPeerId || oldPeerId === newPeerId) {
    return state;
  }
  const next = clone(state);
  const oldEntry = next.roster.find((r) => r.peerId === oldPeerId);
  const newEntry = next.roster.find((r) => r.peerId === newPeerId);
  next.roster = next.roster.filter(
    (r) => r.peerId !== oldPeerId && r.peerId !== newPeerId,
  );
  const merged = {
    ...(oldEntry || {}),
    ...(newEntry || {}),
    peerId: newPeerId,
    displayName:
      patch.displayName ||
      newEntry?.displayName ||
      oldEntry?.displayName ||
      "Guest",
    role: oldEntry?.role === "host" || newEntry?.role === "host" ? "host" : "member",
    joinedAt: oldEntry?.joinedAt || newEntry?.joinedAt || Date.now(),
    colorIndex: oldEntry?.colorIndex ?? newEntry?.colorIndex ?? nextColorIndex(next),
    trip: patch.trip !== undefined ? patch.trip : newEntry?.trip || oldEntry?.trip,
    contPub:
      patch.contPub !== undefined
        ? patch.contPub
        : newEntry?.contPub || oldEntry?.contPub,
    online: patch.online !== undefined ? patch.online : true,
  };
  next.roster.push(merged);

  for (const chat of Object.values(next.groups)) {
    chat.memberPeerIds = uniqueStrings(
      (chat.memberPeerIds || []).map((p) => (p === oldPeerId ? newPeerId : p)),
    );
  }
  for (const list of Object.values(next.groupMessages)) {
    for (const msg of list) {
      if (msg.senderPeerId === oldPeerId) msg.senderPeerId = newPeerId;
      if (msg.forward?.fromPeerId === oldPeerId) {
        msg.forward = { ...msg.forward, fromPeerId: newPeerId };
      }
      if (Array.isArray(msg.delivery?.ackedBy)) {
        msg.delivery = {
          ...msg.delivery,
          ackedBy: uniqueStrings(
            msg.delivery.ackedBy.map((p) => (p === oldPeerId ? newPeerId : p)),
          ),
        };
      }
      if (Array.isArray(msg.reactions)) {
        msg.reactions = msg.reactions.map((rx) => ({
          ...rx,
          peerIds: uniqueStrings(
            (rx.peerIds || []).map((p) => (p === oldPeerId ? newPeerId : p)),
          ),
        }));
      }
    }
  }
  return next;
}

/**
 * @param {HostState} state
 * @param {object} action
 * @param {{ actorPeerId: string }} ctx
 * @returns {{ ok: true, state: HostState, effects: Effect[] } | { ok: false, error: string }}
 */
export function applyHost(state, action, ctx) {
  if (!action || typeof action.type !== "string") {
    return { ok: false, error: "Missing action type" };
  }
  if (state.session.ended && action.type !== "admin-end-session") {
    return { ok: false, error: "Session ended" };
  }

  const actor = ctx.actorPeerId;
  const next = clone(state);
  /** @type {Effect[]} */
  const effects = [];

  switch (action.type) {
    case "create-dm":
      return { ok: false, error: "DMs are not created on the host path" };

    case "create-group": {
      const title = String(action.title || "").trim() || "Group";
      const mode = normalizeGroupMode(action.mode);
      /** @type {string[]} */
      let memberPeerIds;
      if (mode === "everyone") {
        memberPeerIds = uniqueStrings(next.roster.map((r) => r.peerId));
        if (!memberPeerIds.includes(actor)) memberPeerIds.push(actor);
      } else if (mode === "public") {
        memberPeerIds = [actor];
      } else {
        memberPeerIds = uniqueStrings([
          actor,
          ...(Array.isArray(action.memberPeerIds) ? action.memberPeerIds : []),
        ]);
        if (memberPeerIds.length < 2) {
          return { ok: false, error: "Group needs at least 2 members" };
        }
      }
      for (const pid of memberPeerIds) {
        if (!rosterHas(next, pid)) {
          return { ok: false, error: `Unknown peer: ${pid}` };
        }
      }
      const id = mintId("g");
      const chat = {
        id,
        type: /** @type {const} */ ("group"),
        title,
        memberPeerIds,
        createdBy: actor,
        createdAt: Date.now(),
        mode,
      };
      next.groups[id] = chat;
      next.groupMessages[id] = [];
      effects.push({
        event: "chat-created",
        chat: clone(chat),
        // Hint for wire fanout (public stubs → whole swarm).
        publicStub: mode === "public",
      });
      return { ok: true, state: next, effects };
    }

    case "join-group": {
      const chatId = action.chatId;
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (groupModeOf(chat) !== "public") {
        return { ok: false, error: "Only public groups can be joined freely" };
      }
      if (chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Already in this group" };
      }
      chat.memberPeerIds = [...chat.memberPeerIds, actor];
      effects.push({
        event: "chat-created",
        chat: clone(chat),
        messages: clone(next.groupMessages[chatId] || []),
      });
      const actorName =
        next.roster.find((r) => r.peerId === actor)?.displayName || "Someone";
      const sys = {
        id: mintId("sys"),
        chatId,
        senderPeerId: "",
        createdAt: Date.now(),
        kind: /** @type {const} */ ("system"),
        text: `${actorName} joined`,
      };
      next.groupMessages[chatId] = [
        ...(next.groupMessages[chatId] || []),
        sys,
      ];
      effects.push({ event: "message-added", chatId, message: sys });
      return { ok: true, state: next, effects };
    }

    case "add-group-members": {
      const chatId = action.chatId;
      const addIds = uniqueStrings(
        Array.isArray(action.memberPeerIds) ? action.memberPeerIds : [],
      ).filter((pid) => pid !== actor);
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (groupModeOf(chat) === "everyone") {
        return { ok: false, error: "Everyone is already in this group" };
      }
      const canAdd =
        isHostPeer(next, actor) || chat.memberPeerIds.includes(actor);
      if (!canAdd) {
        return { ok: false, error: "Not allowed to add members" };
      }
      if (!addIds.length) {
        return { ok: false, error: "No members to add" };
      }
      /** @type {string[]} */
      const added = [];
      for (const pid of addIds) {
        if (!rosterHas(next, pid)) {
          return { ok: false, error: `Unknown peer: ${pid}` };
        }
        if (chat.memberPeerIds.includes(pid)) continue;
        chat.memberPeerIds = [...chat.memberPeerIds, pid];
        added.push(pid);
      }
      if (!added.length) {
        return { ok: false, error: "Those peers are already in the group" };
      }
      effects.push({
        event: "chat-created",
        chat: clone(chat),
        messages: clone(next.groupMessages[chatId] || []),
      });
      const names = added
        .map(
          (pid) =>
            next.roster.find((r) => r.peerId === pid)?.displayName || pid,
        )
        .join(", ");
      const actorName =
        next.roster.find((r) => r.peerId === actor)?.displayName || "Someone";
      const sys = {
        id: mintId("sys"),
        chatId,
        senderPeerId: "",
        createdAt: Date.now(),
        kind: /** @type {const} */ ("system"),
        text: `${actorName} added ${names}`,
      };
      next.groupMessages[chatId] = [
        ...(next.groupMessages[chatId] || []),
        sys,
      ];
      effects.push({ event: "message-added", chatId, message: sys });
      return { ok: true, state: next, effects };
    }

    case "send-text": {
      const chatId = action.chatId;
      const text = String(action.text ?? "");
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (!chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (!text.trim()) {
        return { ok: false, error: "Empty message" };
      }
      const fwd = normalizeForward(action.forward);
      const msg = {
        id: mintId("m"),
        chatId,
        senderPeerId: actor,
        createdAt: Date.now(),
        kind: "text",
        text,
        entities: Array.isArray(action.entities) ? action.entities : undefined,
        replyTo: action.replyTo,
        forward: fwd,
        delivery: { ackedBy: [] },
      };
      next.groupMessages[chatId] = [...(next.groupMessages[chatId] || []), msg];
      effects.push({ event: "message-added", chatId, message: msg });
      return { ok: true, state: next, effects };
    }

    case "send-sticker": {
      const chatId = action.chatId;
      const pack = String(action.pack || action.sticker?.pack || "").trim();
      const stickerId = String(
        action.stickerId || action.sticker?.stickerId || "",
      ).trim();
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (!chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (!pack || !stickerId) {
        return { ok: false, error: "Missing sticker ref" };
      }
      const msg = {
        id: mintId("m"),
        chatId,
        senderPeerId: actor,
        createdAt: Date.now(),
        kind: /** @type {const} */ ("sticker"),
        sticker: { pack, stickerId },
        replyTo: action.replyTo,
        forward: normalizeForward(action.forward),
        delivery: { ackedBy: [] },
      };
      next.groupMessages[chatId] = [...(next.groupMessages[chatId] || []), msg];
      effects.push({ event: "message-added", chatId, message: msg });
      return { ok: true, state: next, effects };
    }

    case "send-media": {
      const chatId = action.chatId;
      const mediaIds = normalizeMediaIds(action.mediaIds);
      const mediaInfo = normalizeMediaInfo(action.mediaInfo, mediaIds.length);
      const mediaKind = String(
        action.mediaKind || action.kindHint || "",
      ).toLowerCase();
      const asVideo =
        mediaKind === "video" || looksLikeVideoInfo(mediaInfo, mediaIds.length);
      const asAudio =
        mediaKind === "audio" || looksLikeAudioInfo(mediaInfo, mediaIds.length);
      const asFile =
        mediaKind === "file" || looksLikeFileInfo(mediaInfo, mediaIds.length);
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (!chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (!mediaIds.length) {
        return { ok: false, error: "Missing media" };
      }
      if (asVideo) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "Video must be a single clip" };
        }
      } else if (asAudio) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "Audio must be a single clip" };
        }
      } else if (asFile) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "File must be a single document" };
        }
      } else if (mediaIds.length > MAX_ALBUM_ITEMS) {
        return { ok: false, error: `Album max ${MAX_ALBUM_ITEMS} images` };
      }
      const caption = String(action.text ?? action.caption ?? "");
      const kind = asVideo
        ? /** @type {const} */ ("video")
        : asAudio
          ? /** @type {const} */ ("audio")
          : asFile
            ? /** @type {const} */ ("file")
            : mediaIds.length === 1
              ? /** @type {const} */ ("media")
              : /** @type {const} */ ("album");
      const msg = {
        id: mintId("m"),
        chatId,
        senderPeerId: actor,
        createdAt: Date.now(),
        kind,
        mediaIds,
        mediaInfo,
        text: caption.trim() ? caption : undefined,
        entities: Array.isArray(action.entities) ? action.entities : undefined,
        replyTo: action.replyTo,
        forward: normalizeForward(action.forward),
        delivery: { ackedBy: [] },
      };
      next.groupMessages[chatId] = [...(next.groupMessages[chatId] || []), msg];
      effects.push({ event: "message-added", chatId, message: msg });
      return { ok: true, state: next, effects };
    }

    case "edit-message": {
      const chatId = action.chatId;
      const messageId = action.messageId;
      const text = String(action.text ?? "");
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const msgs = next.groupMessages[chatId] || [];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return { ok: false, error: "Unknown message" };
      const msg = msgs[idx];
      if (msg.kind !== "text") {
        return { ok: false, error: "Can only edit text messages" };
      }
      if (msg.senderPeerId !== actor) {
        return { ok: false, error: "Can only edit own messages" };
      }
      if (!text.trim()) return { ok: false, error: "Empty message" };
      const updated = {
        ...msg,
        text,
        entities: Array.isArray(action.entities) ? action.entities : undefined,
        editedAt: Date.now(),
      };
      next.groupMessages[chatId] = [
        ...msgs.slice(0, idx),
        updated,
        ...msgs.slice(idx + 1),
      ];
      effects.push({ event: "message-edited", chatId, message: updated });
      return { ok: true, state: next, effects };
    }

    case "ack-delivery": {
      const chatId = action.chatId;
      const messageIds = Array.isArray(action.messageIds)
        ? action.messageIds.map(String)
        : [];
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      if (!next.groups[chatId].memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      let changed = false;
      const msgs = [...(next.groupMessages[chatId] || [])];
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (!messageIds.includes(msg.id)) continue;
        if (msg.senderPeerId === actor) continue;
        const ackedBy = [...(msg.delivery?.ackedBy || [])];
        if (ackedBy.includes(actor)) continue;
        ackedBy.push(actor);
        msgs[i] = { ...msg, delivery: { ackedBy } };
        changed = true;
        effects.push({
          event: "message-delivery",
          chatId,
          messageId: msg.id,
          delivery: { ackedBy },
        });
      }
      if (!changed) return { ok: true, state: next, effects: [] };
      next.groupMessages[chatId] = msgs;
      return { ok: true, state: next, effects };
    }

    case "delete-message": {
      const chatId = action.chatId;
      const messageId = action.messageId;
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const msgs = next.groupMessages[chatId] || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return { ok: false, error: "Unknown message" };
      const hostOk = isHostPeer(next, actor);
      if (!hostOk && msg.senderPeerId !== actor) {
        return { ok: false, error: "Cannot delete this message" };
      }
      next.groupMessages[chatId] = msgs.filter((m) => m.id !== messageId);
      effects.push({ event: "message-deleted", chatId, messageId });
      return { ok: true, state: next, effects };
    }

    case "delete-group": {
      const chatId = action.chatId;
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const group = next.groups[chatId];
      // Session host can delete any group; the creator can delete their own.
      if (!isHostPeer(next, actor) && group.createdBy !== actor) {
        return { ok: false, error: "Only the host or group creator can delete" };
      }
      const members = [...group.memberPeerIds];
      const wasPublic = groupModeOf(group) === "public";
      delete next.groups[chatId];
      delete next.groupMessages[chatId];
      effects.push({
        event: "chat-deleted",
        chatId,
        memberPeerIds: members,
        publicStub: wasPublic,
      });
      return { ok: true, state: next, effects };
    }

    case "leave-group": {
      const chatId = action.chatId;
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (groupModeOf(chat) === "everyone") {
        return { ok: false, error: "Cannot leave an Everyone group" };
      }
      if (!chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (isHostPeer(next, actor)) {
        return { ok: false, error: "Host cannot leave groups; delete instead" };
      }
      chat.memberPeerIds = chat.memberPeerIds.filter((p) => p !== actor);
      // Keep the group — public leavers see name-only again; private undersized stays.
      effects.push({
        event: "chat-created",
        chat: clone(chat),
        publicStub: groupModeOf(chat) === "public",
      });
      return { ok: true, state: next, effects };
    }

    case "admin-end-session": {
      if (!isHostPeer(next, actor)) {
        return { ok: false, error: "Only host can end session" };
      }
      next.session.ended = true;
      effects.push({ event: "session-ended" });
      return { ok: true, state: next, effects };
    }

    case "admin-rename-session": {
      if (!isHostPeer(next, actor)) {
        return { ok: false, error: "Only host can rename session" };
      }
      const title = String(action.title || "").trim();
      if (!title) return { ok: false, error: "Empty title" };
      if (title.length > 80) {
        return { ok: false, error: "Title too long" };
      }
      next.session.title = title;
      effects.push({ event: "session-renamed", title });
      return { ok: true, state: next, effects };
    }

    case "admin-kick": {
      if (!isHostPeer(next, actor)) {
        return { ok: false, error: "Only host can kick" };
      }
      const peerId = String(action.peerId || "").trim();
      if (!peerId) return { ok: false, error: "Missing peer" };
      if (isHostPeer(next, peerId)) {
        return { ok: false, error: "Cannot kick host" };
      }
      if (!rosterHas(next, peerId)) {
        return { ok: false, error: "Peer not in roster" };
      }
      next.roster = next.roster.filter((r) => r.peerId !== peerId);
      for (const [id, chat] of Object.entries(next.groups)) {
        if (!chat.memberPeerIds.includes(peerId)) continue;
        chat.memberPeerIds = chat.memberPeerIds.filter((p) => p !== peerId);
        // Keep the group even if undersized — only kebab Delete group removes it.
        effects.push({ event: "chat-created", chat: clone(chat) });
      }
      effects.push({ event: "peer-kicked", peerId });
      return { ok: true, state: next, effects };
    }

    case "set-reaction": {
      const chatId = action.chatId;
      const messageId = action.messageId;
      const emoji = String(action.emoji || "").trim();
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      if (!next.groups[chatId].memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (!messageId || !emoji) {
        return { ok: false, error: "Missing reaction" };
      }
      if (emoji.length > 8) {
        return { ok: false, error: "Invalid emoji" };
      }
      const msgs = next.groupMessages[chatId] || [];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return { ok: false, error: "Unknown message" };
      const msg = msgs[idx];
      if (msg.kind === "system") {
        return { ok: false, error: "Cannot react to system message" };
      }
      const updated = {
        ...msg,
        reactions: toggleReaction(msg.reactions, emoji, actor),
      };
      next.groupMessages[chatId] = [
        ...msgs.slice(0, idx),
        updated,
        ...msgs.slice(idx + 1),
      ];
      effects.push({ event: "message-updated", chatId, message: updated });
      return { ok: true, state: next, effects };
    }

    case "forward-message": {
      const fromChatId = action.fromChatId;
      const toChatId = action.toChatId;
      const messageId = action.messageId;
      if (!fromChatId || !toChatId || !messageId) {
        return { ok: false, error: "Missing forward fields" };
      }
      if (!next.groups[fromChatId] || !next.groups[toChatId]) {
        return { ok: false, error: "Unknown group" };
      }
      if (!next.groups[fromChatId].memberPeerIds.includes(actor)) {
        return { ok: false, error: "Cannot read source chat" };
      }
      if (!next.groups[toChatId].memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a member of target group" };
      }
      const src = (next.groupMessages[fromChatId] || []).find(
        (m) => m.id === messageId,
      );
      if (!src || src.kind === "system") {
        return { ok: false, error: "Unknown message" };
      }
      const fromName =
        String(action.fromName || "").trim() ||
        next.roster.find((r) => r.peerId === src.senderPeerId)?.displayName ||
        "Someone";
      const msg = buildForwardedMessage(src, {
        chatId: toChatId,
        senderPeerId: actor,
        fromName,
        fromPeerId: src.senderPeerId,
        fromChatId,
      });
      next.groupMessages[toChatId] = [
        ...(next.groupMessages[toChatId] || []),
        msg,
      ];
      effects.push({ event: "message-added", chatId: toChatId, message: msg });
      return { ok: true, state: next, effects };
    }

    default:
      return { ok: false, error: `Unknown host action: ${action.type}` };
  }
}

/**
 * Apply a host event onto guest (or host mirror) state.
 * @param {HostState} state
 * @param {object} body
 * @returns {HostState}
 */
export function applyHostEvent(state, body) {
  const next = clone(state);
  if (Number.isFinite(Number(body.revision))) {
    next.meta = {
      ...(next.meta || {}),
      revision: Math.max(
        Number(next.meta?.revision) || 0,
        Number(body.revision),
      ),
    };
  }
  if (body.chatId && Number.isFinite(Number(body.groupRevision))) {
    next.meta = {
      ...(next.meta || {}),
      groupRevisions: {
        ...(next.meta?.groupRevisions || {}),
        [body.chatId]: Math.max(
          Number(next.meta?.groupRevisions?.[body.chatId]) || 0,
          Number(body.groupRevision),
        ),
      },
    };
  }
  const event = body.event;
  switch (event) {
    case "chat-created": {
      const chat = body.chat;
      if (!chat?.id) return next;
      next.groups[chat.id] = chat;
      if (Array.isArray(body.messages)) {
        next.groupMessages[chat.id] = clone(body.messages);
      } else if (!next.groupMessages[chat.id]) {
        next.groupMessages[chat.id] = [];
      }
      return next;
    }
    case "message-added": {
      const msg = body.message;
      const chatId = body.chatId || msg?.chatId;
      if (!msg?.id || !chatId) return next;
      if (!next.groups[chatId]) return next;
      const list = next.groupMessages[chatId] || [];
      if (list.some((m) => m.id === msg.id)) return next;
      next.groupMessages[chatId] = [...list, msg];
      return next;
    }
    case "message-deleted": {
      const { chatId, messageId } = body;
      if (!chatId || !messageId || !next.groupMessages[chatId]) return next;
      next.groupMessages[chatId] = next.groupMessages[chatId].filter(
        (m) => m.id !== messageId,
      );
      return next;
    }
    case "chat-deleted": {
      const { chatId } = body;
      if (!chatId) return next;
      delete next.groups[chatId];
      delete next.groupMessages[chatId];
      return next;
    }
    case "message-edited":
    case "message-updated": {
      const msg = body.message;
      const chatId = body.chatId || msg?.chatId;
      if (!msg?.id || !chatId || !next.groupMessages[chatId]) return next;
      next.groupMessages[chatId] = next.groupMessages[chatId].map((m) =>
        m.id === msg.id ? msg : m,
      );
      return next;
    }
    case "message-delivery": {
      const { chatId, messageId, delivery } = body;
      if (!chatId || !messageId || !delivery || !next.groupMessages[chatId]) {
        return next;
      }
      next.groupMessages[chatId] = next.groupMessages[chatId].map((m) =>
        m.id === messageId ? { ...m, delivery } : m,
      );
      return next;
    }
    case "session-renamed": {
      const title = String(body.title || "").trim();
      if (title) next.session.title = title;
      return next;
    }
    case "peer-kicked": {
      const peerId = String(body.peerId || "").trim();
      if (!peerId) return next;
      next.roster = next.roster.filter((r) => r.peerId !== peerId);
      return next;
    }
    default:
      return next;
  }
}

/**
 * Append system lines into every group that includes peerId (or listed groups).
 * @param {HostState} state
 * @param {string} text
 * @param {string[]} groupIds
 * @returns {{ state: HostState, effects: Effect[] }}
 */
export function appendSystemToGroups(state, text, groupIds) {
  const next = clone(state);
  /** @type {Effect[]} */
  const effects = [];
  for (const chatId of groupIds) {
    if (!next.groups[chatId]) continue;
    const msg = {
      id: mintId("sys"),
      chatId,
      senderPeerId: "",
      createdAt: Date.now(),
      kind: /** @type {const} */ ("system"),
      text,
    };
    next.groupMessages[chatId] = [...(next.groupMessages[chatId] || []), msg];
    effects.push({ event: "message-added", chatId, message: msg });
  }
  return { state: next, effects };
}

/**
 * @param {HostState} hostState
 * @param {DmState} dmState
 * @param {string} chatId
 * @param {string} messageId
 * @returns {Message | null}
 */
export function findMessage(hostState, dmState, chatId, messageId) {
  const g = hostState.groupMessages[chatId];
  if (g) return g.find((m) => m.id === messageId) || null;
  const d = dmState.dmMessages[chatId];
  if (d) return d.find((m) => m.id === messageId) || null;
  return null;
}

/**
 * @param {DmState} dmState
 * @param {string} selfPeerId
 * @param {object} action
 * @param {{ remoteSenderPeerId?: string }} [opts]
 * @returns {{ ok: true, state: DmState, message?: Message, dmId?: string } | { ok: false, error: string }}
 */
export function applyDm(dmState, selfPeerId, action, opts = {}) {
  if (!action || typeof action.type !== "string") {
    return { ok: false, error: "Missing action type" };
  }
  const next = clone(dmState);
  const remote = opts.remoteSenderPeerId;

  switch (action.type) {
    case "dm-open": {
      const otherPeerId = remote || action.peerId || action.otherPeerId;
      if (!otherPeerId || otherPeerId === selfPeerId) {
        return { ok: false, error: "Invalid DM peer" };
      }
      const dmId = dmIdFor(selfPeerId, otherPeerId);
      if (!next.dms[dmId]) {
        next.dms[dmId] = {
          id: dmId,
          type: "dm",
          memberPeerIds: [selfPeerId, otherPeerId].sort(),
          createdBy: remote || selfPeerId,
          createdAt: Date.now(),
        };
        next.dmMessages[dmId] = [];
      }
      return { ok: true, state: next, dmId };
    }

    case "dm-send-text": {
      const otherFromRemote = remote;
      let dmId = action.dmId || action.chatId;
      if (!dmId && otherFromRemote) {
        dmId = dmIdFor(selfPeerId, otherFromRemote);
      }
      const text = String(action.text ?? action.message?.text ?? "");
      if (!dmId) return { ok: false, error: "Unknown DM" };

      if (!next.dms[dmId]) {
        if (!otherFromRemote) return { ok: false, error: "Unknown DM" };
        const open = applyDm(
          next,
          selfPeerId,
          { type: "dm-open", peerId: otherFromRemote },
          { remoteSenderPeerId: otherFromRemote },
        );
        if (!open.ok) return open;
        Object.assign(next, open.state);
      }

      const chat = next.dms[dmId];
      if (!chat.memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (otherFromRemote && !chat.memberPeerIds.includes(otherFromRemote)) {
        return { ok: false, error: "Sender not in DM" };
      }
      if (!text.trim() && !action.message?.text) {
        return { ok: false, error: "Empty message" };
      }

      const senderPeerId = otherFromRemote || selfPeerId;
      /** @type {Message} */
      const msg = action.message
        ? {
            ...action.message,
            chatId: dmId,
            senderPeerId,
            delivery: action.message.delivery || { ackedBy: [] },
          }
        : {
            id: mintId("m"),
            chatId: dmId,
            senderPeerId,
            createdAt: Date.now(),
            kind: "text",
            text,
            entities: Array.isArray(action.entities)
              ? action.entities
              : undefined,
            replyTo: action.replyTo,
            delivery: { ackedBy: [] },
          };

      const list = next.dmMessages[dmId] || [];
      if (list.some((m) => m.id === msg.id)) {
        return { ok: true, state: next, message: msg, dmId };
      }
      next.dmMessages[dmId] = [...list, msg];
      return { ok: true, state: next, message: msg, dmId };
    }

    case "dm-send-sticker": {
      const otherFromRemote = remote;
      let dmId = action.dmId || action.chatId;
      if (!dmId && otherFromRemote) {
        dmId = dmIdFor(selfPeerId, otherFromRemote);
      }
      const pack = String(action.pack || action.sticker?.pack || "").trim();
      const stickerId = String(
        action.stickerId || action.sticker?.stickerId || "",
      ).trim();
      if (!dmId) return { ok: false, error: "Unknown DM" };
      if (!pack || !stickerId) {
        return { ok: false, error: "Missing sticker ref" };
      }

      if (!next.dms[dmId]) {
        if (!otherFromRemote) return { ok: false, error: "Unknown DM" };
        const open = applyDm(
          next,
          selfPeerId,
          { type: "dm-open", peerId: otherFromRemote },
          { remoteSenderPeerId: otherFromRemote },
        );
        if (!open.ok) return open;
        Object.assign(next, open.state);
      }

      const chat = next.dms[dmId];
      if (!chat.memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (otherFromRemote && !chat.memberPeerIds.includes(otherFromRemote)) {
        return { ok: false, error: "Sender not in DM" };
      }

      const senderPeerId = otherFromRemote || selfPeerId;
      /** @type {Message} */
      const msg = action.message
        ? {
            ...action.message,
            chatId: dmId,
            senderPeerId,
            kind: "sticker",
            sticker: { pack, stickerId },
            delivery: action.message.delivery || { ackedBy: [] },
          }
        : {
            id: mintId("m"),
            chatId: dmId,
            senderPeerId,
            createdAt: Date.now(),
            kind: "sticker",
            sticker: { pack, stickerId },
            replyTo: action.replyTo,
            delivery: { ackedBy: [] },
          };

      const list = next.dmMessages[dmId] || [];
      if (list.some((m) => m.id === msg.id)) {
        return { ok: true, state: next, message: msg, dmId };
      }
      next.dmMessages[dmId] = [...list, msg];
      return { ok: true, state: next, message: msg, dmId };
    }

    case "dm-send-media": {
      const otherFromRemote = remote;
      let dmId = action.dmId || action.chatId;
      if (!dmId && otherFromRemote) {
        dmId = dmIdFor(selfPeerId, otherFromRemote);
      }
      const mediaIds = normalizeMediaIds(
        action.mediaIds || action.message?.mediaIds,
      );
      const mediaInfo = normalizeMediaInfo(
        action.mediaInfo || action.message?.mediaInfo,
        mediaIds.length,
      );
      const mediaKind = String(
        action.mediaKind ||
          action.kindHint ||
          action.message?.kind ||
          "",
      ).toLowerCase();
      const asVideo =
        mediaKind === "video" ||
        action.message?.kind === "video" ||
        looksLikeVideoInfo(mediaInfo, mediaIds.length);
      const asAudio =
        mediaKind === "audio" ||
        action.message?.kind === "audio" ||
        looksLikeAudioInfo(mediaInfo, mediaIds.length);
      const asFile =
        mediaKind === "file" ||
        action.message?.kind === "file" ||
        looksLikeFileInfo(mediaInfo, mediaIds.length);
      if (!dmId) return { ok: false, error: "Unknown DM" };
      if (!mediaIds.length) return { ok: false, error: "Missing media" };
      if (asVideo) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "Video must be a single clip" };
        }
      } else if (asAudio) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "Audio must be a single clip" };
        }
      } else if (asFile) {
        if (mediaIds.length !== 1) {
          return { ok: false, error: "File must be a single document" };
        }
      } else if (mediaIds.length > MAX_ALBUM_ITEMS) {
        return { ok: false, error: `Album max ${MAX_ALBUM_ITEMS} images` };
      }

      if (!next.dms[dmId]) {
        if (!otherFromRemote) return { ok: false, error: "Unknown DM" };
        const open = applyDm(
          next,
          selfPeerId,
          { type: "dm-open", peerId: otherFromRemote },
          { remoteSenderPeerId: otherFromRemote },
        );
        if (!open.ok) return open;
        Object.assign(next, open.state);
      }

      const chat = next.dms[dmId];
      if (!chat.memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (otherFromRemote && !chat.memberPeerIds.includes(otherFromRemote)) {
        return { ok: false, error: "Sender not in DM" };
      }

      const senderPeerId = otherFromRemote || selfPeerId;
      const caption = String(
        action.text ?? action.caption ?? action.message?.text ?? "",
      );
      const kind = /** @type {"media" | "album" | "video" | "audio" | "file"} */ (
        asVideo
          ? "video"
          : asAudio
            ? "audio"
            : asFile
              ? "file"
              : mediaIds.length === 1
                ? "media"
                : "album"
      );
      /** @type {Message} */
      const msg = action.message
        ? {
            ...action.message,
            chatId: dmId,
            senderPeerId,
            kind,
            mediaIds,
            mediaInfo: mediaInfo || action.message.mediaInfo,
            text: caption.trim() ? caption : action.message.text,
            delivery: action.message.delivery || { ackedBy: [] },
          }
        : {
            id: mintId("m"),
            chatId: dmId,
            senderPeerId,
            createdAt: Date.now(),
            kind,
            mediaIds,
            mediaInfo,
            text: caption.trim() ? caption : undefined,
            entities: Array.isArray(action.entities)
              ? action.entities
              : undefined,
            replyTo: action.replyTo,
            delivery: { ackedBy: [] },
          };

      const list = next.dmMessages[dmId] || [];
      if (list.some((m) => m.id === msg.id)) {
        return { ok: true, state: next, message: msg, dmId };
      }
      next.dmMessages[dmId] = [...list, msg];
      return { ok: true, state: next, message: msg, dmId };
    }

    case "dm-edit": {
      const dmId = action.dmId || action.chatId;
      const messageId = action.messageId;
      const text = String(action.text ?? "");
      if (!dmId || !next.dms[dmId]) return { ok: false, error: "Unknown DM" };
      const msgs = next.dmMessages[dmId] || [];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return { ok: false, error: "Unknown message" };
      const msg = msgs[idx];
      const editor = remote || selfPeerId;
      if (msg.senderPeerId !== editor) {
        return { ok: false, error: "Can only edit own messages" };
      }
      if (msg.kind !== "text") {
        return { ok: false, error: "Can only edit text messages" };
      }
      if (!text.trim()) return { ok: false, error: "Empty message" };
      const updated = {
        ...msg,
        text,
        entities: Array.isArray(action.entities) ? action.entities : undefined,
        editedAt: action.editedAt || Date.now(),
      };
      next.dmMessages[dmId] = [
        ...msgs.slice(0, idx),
        updated,
        ...msgs.slice(idx + 1),
      ];
      return { ok: true, state: next, message: updated, dmId };
    }

    case "dm-ack": {
      const dmId = action.dmId || action.chatId;
      const messageIds = Array.isArray(action.messageIds)
        ? action.messageIds.map(String)
        : [];
      if (!dmId || !next.dms[dmId]) return { ok: false, error: "Unknown DM" };
      const acker = remote || selfPeerId;
      const msgs = [...(next.dmMessages[dmId] || [])];
      let changed = false;
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i];
        if (!messageIds.includes(msg.id)) continue;
        if (msg.senderPeerId === acker) continue;
        const ackedBy = [...(msg.delivery?.ackedBy || [])];
        if (ackedBy.includes(acker)) continue;
        ackedBy.push(acker);
        msgs[i] = { ...msg, delivery: { ackedBy } };
        changed = true;
      }
      if (changed) next.dmMessages[dmId] = msgs;
      return { ok: true, state: next, dmId };
    }

    case "dm-delete": {
      const dmId = action.dmId || action.chatId;
      const messageId = action.messageId;
      if (!dmId || !next.dms[dmId]) return { ok: false, error: "Unknown DM" };
      const msgs = next.dmMessages[dmId] || [];
      const msg = msgs.find((m) => m.id === messageId);
      if (!msg) return { ok: false, error: "Unknown message" };
      const actor = remote || selfPeerId;
      if (msg.senderPeerId !== actor) {
        return { ok: false, error: "Can only delete own DM messages" };
      }
      next.dmMessages[dmId] = msgs.filter((m) => m.id !== messageId);
      return { ok: true, state: next, dmId };
    }

    case "dm-reaction": {
      const dmId = action.dmId || action.chatId;
      const messageId = action.messageId;
      const emoji = String(action.emoji || "").trim();
      if (!dmId || !next.dms[dmId]) return { ok: false, error: "Unknown DM" };
      if (!next.dms[dmId].memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (remote && !next.dms[dmId].memberPeerIds.includes(remote)) {
        return { ok: false, error: "Sender not in DM" };
      }
      if (!messageId || !emoji || emoji.length > 8) {
        return { ok: false, error: "Missing reaction" };
      }
      const actor = remote || selfPeerId;
      const msgs = next.dmMessages[dmId] || [];
      const idx = msgs.findIndex((m) => m.id === messageId);
      if (idx < 0) return { ok: false, error: "Unknown message" };
      const msg = msgs[idx];
      if (msg.kind === "system") {
        return { ok: false, error: "Cannot react to system message" };
      }
      const updated = {
        ...msg,
        reactions: toggleReaction(msg.reactions, emoji, actor),
      };
      next.dmMessages[dmId] = [
        ...msgs.slice(0, idx),
        updated,
        ...msgs.slice(idx + 1),
      ];
      return { ok: true, state: next, message: updated, dmId };
    }

    case "dm-forward": {
      const dmId = action.dmId || action.chatId;
      if (!dmId) return { ok: false, error: "Unknown DM" };
      if (!next.dms[dmId]) {
        if (!remote) return { ok: false, error: "Unknown DM" };
        const open = applyDm(
          next,
          selfPeerId,
          { type: "dm-open", peerId: remote },
          { remoteSenderPeerId: remote },
        );
        if (!open.ok) return open;
        Object.assign(next, open.state);
      }
      const chat = next.dms[dmId];
      if (!chat.memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (remote && !chat.memberPeerIds.includes(remote)) {
        return { ok: false, error: "Sender not in DM" };
      }
      const senderPeerId = remote || selfPeerId;
      /** @type {Message | undefined} */
      let msg = action.message;
      if (!msg || typeof msg !== "object") {
        return { ok: false, error: "Missing forwarded message" };
      }
      msg = {
        ...msg,
        id: msg.id || mintId("m"),
        chatId: dmId,
        senderPeerId,
        createdAt: msg.createdAt || Date.now(),
        delivery: msg.delivery || { ackedBy: [] },
        forward: normalizeForward(msg.forward || action.forward),
      };
      const list = next.dmMessages[dmId] || [];
      if (list.some((m) => m.id === msg.id)) {
        return { ok: true, state: next, message: msg, dmId };
      }
      next.dmMessages[dmId] = [...list, msg];
      return { ok: true, state: next, message: msg, dmId };
    }

    default:
      return { ok: false, error: `Unknown DM action: ${action.type}` };
  }
}

/**
 * Merge groups + my DMs for the sidebar.
 * @param {HostState} hostState
 * @param {DmState} dmState
 * @param {string} selfPeerId
 */
export function listChatsForUi(hostState, dmState, selfPeerId) {
  /** @type {Array<{ id: string, kind: "group" | "dm", title: string, preview: string, updatedAt: number, memberPeerIds: string[] }>} */
  const items = [];
  const asHost = isHostPeer(hostState, selfPeerId);

  /** @type {typeof items} */
  const joined = [];
  /** @type {typeof items} */
  const publicBrowse = [];

  for (const chat of Object.values(hostState.groups)) {
    const mode = groupModeOf(chat);
    const isMember = chat.memberPeerIds.includes(selfPeerId);
    if (!isMember && mode !== "public") continue;
    // Host sees private groups they're not in via filter — still list only if member
    // unless public browse. Host is usually a member of groups they care about;
    // for private non-member host admin views, skip browse list (they're in full state).
    if (!isMember && mode === "public") {
      publicBrowse.push({
        id: chat.id,
        kind: "group",
        title: chat.title || "Public group",
        preview: "",
        updatedAt: chat.createdAt,
        memberPeerIds: chat.memberPeerIds,
        mode: "public",
        joined: false,
        offline: false,
      });
      continue;
    }
    if (!isMember && !asHost) continue;
    if (!isMember) continue; // host non-member private: omit from rail
    const msgs = hostState.groupMessages[chat.id] || [];
    const last = msgs[msgs.length - 1];
    joined.push({
      id: chat.id,
      kind: "group",
      title: chat.title || "Group",
      preview: previewText(last),
      updatedAt: last?.createdAt || chat.createdAt,
      memberPeerIds: chat.memberPeerIds,
      mode,
      joined: true,
      // Groups aren't "offline" — that label is for 1:1 DMs only.
      offline: false,
    });
  }

  for (const chat of Object.values(dmState.dms)) {
    if (!chat.memberPeerIds.includes(selfPeerId)) continue;
    const otherId = chat.memberPeerIds.find((p) => p !== selfPeerId);
    const other = hostState.roster.find((r) => r.peerId === otherId);
    const msgs = dmState.dmMessages[chat.id] || [];
    const last = msgs[msgs.length - 1];
    joined.push({
      id: chat.id,
      kind: "dm",
      title: other?.displayName || otherId || "DM",
      preview: previewText(last),
      updatedAt: last?.createdAt || chat.createdAt,
      memberPeerIds: chat.memberPeerIds,
      tripPeerId: otherId,
      trip: other?.trip,
      joined: true,
      offline: Boolean(other && other.online === false),
    });
  }

  joined.sort((a, b) => b.updatedAt - a.updatedAt);
  publicBrowse.sort((a, b) =>
    String(a.title).localeCompare(String(b.title), undefined, {
      sensitivity: "base",
    }),
  );
  return [...joined, ...publicBrowse];
}

/**
 * @param {HostState} hostState
 * @param {DmState} dmState
 * @param {string} chatId
 */
export function getChatThread(hostState, dmState, chatId) {
  if (hostState.groups[chatId]) {
    return {
      kind: /** @type {const} */ ("group"),
      chat: hostState.groups[chatId],
      messages: hostState.groupMessages[chatId] || [],
    };
  }
  if (dmState.dms[chatId]) {
    return {
      kind: /** @type {const} */ ("dm"),
      chat: dmState.dms[chatId],
      messages: dmState.dmMessages[chatId] || [],
    };
  }
  return null;
}

/**
 * @param {HostState} hostState
 * @param {DmState} dmState
 */
export function assertHostExcludesDms(hostState, dmState) {
  let snap;
  try {
    snap = hostSnapshot(hostState);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  const json = JSON.stringify(snap);
  if (json.includes('"dms"') || json.includes('"dmMessages"')) {
    return { ok: false, error: "Host snapshot contains DM store keys" };
  }
  for (const dmId of Object.keys(dmState.dms)) {
    if (json.includes(dmId)) {
      return { ok: false, error: `Host snapshot contains DM id ${dmId}` };
    }
  }
  for (const msgs of Object.values(dmState.dmMessages)) {
    for (const m of msgs) {
      if (m.text && json.includes(m.text)) {
        return {
          ok: false,
          error: `Host snapshot contains DM message text: ${m.text}`,
        };
      }
    }
  }
  return { ok: true };
}

/** Target peer ids for a group effect (members; host always included). */
export function fanoutPeerIdsForGroup(state, chatId) {
  const chat = state.groups[chatId];
  const hostId = getHostPeerId(state);
  const set = new Set(chat?.memberPeerIds || []);
  if (hostId) set.add(hostId);
  return [...set];
}

/** True when an effect about this chat should reach the whole roster (public stubs). */
export function effectNeedsRosterFanout(state, effect) {
  if (!effect) return false;
  if (effect.event === "chat-deleted" && effect.chatId) {
    // Deleted public groups: fan out to everyone so stubs disappear.
    // We can't read the chat anymore — callers pass prior mode via effect.publicStub.
    return Boolean(effect.publicStub);
  }
  if (effect.event !== "chat-created" || !effect.chat) return false;
  // History payloads (join / add-members) are member sync — not name-only stubs.
  if (Array.isArray(effect.messages)) return false;
  if (effect.publicStub === true) return true;
  return groupModeOf(effect.chat) === "public";
}

/**
 * Add a peer to every Everyone group they are missing from.
 * @param {HostState} state
 * @param {string} peerId
 * @returns {{ state: HostState, effects: Effect[] }}
 */
export function enrollPeerInEveryoneGroups(state, peerId) {
  if (!state || !peerId || !rosterHas(state, peerId)) {
    return { state, effects: [] };
  }
  const next = clone(state);
  /** @type {Effect[]} */
  const effects = [];
  for (const chat of Object.values(next.groups)) {
    if (groupModeOf(chat) !== "everyone") continue;
    if (chat.memberPeerIds.includes(peerId)) continue;
    chat.memberPeerIds = [...chat.memberPeerIds, peerId];
    effects.push({
      event: "chat-created",
      chat: clone(chat),
      messages: clone(next.groupMessages[chat.id] || []),
      memberPeerIds: [peerId],
    });
  }
  return { state: next, effects };
}

/** @param {unknown} mode @returns {GroupMode} */
function normalizeGroupMode(mode) {
  if (mode === "public" || mode === "everyone") return mode;
  return "private";
}

/**
 * Increment authoritative revisions after a successful host mutation.
 * @param {HostState} state
 * @param {{ chatId?: string }} action
 */
export function bumpHostRevision(state, action = {}) {
  const next = clone(state);
  const revision = (Number(next.meta?.revision) || 0) + 1;
  const groupRevisions = { ...(next.meta?.groupRevisions || {}) };
  if (action.chatId) {
    groupRevisions[action.chatId] =
      (Number(groupRevisions[action.chatId]) || 0) + 1;
  }
  next.meta = { ...(next.meta || {}), revision, groupRevisions };
  return next;
}

/**
 * Reconstruct authoritative state from the visible replicas held by reachable
 * participants after a permanent-room host election.
 * @param {HostState[]} snapshots
 * @param {{ sessionId: string, title: string, hostPeerId: string, hostDisplayName: string, hostTrip?: object, activePeerIds?: string[] }} opts
 */
export function mergeHostSnapshots(snapshots, opts) {
  const valid = (snapshots || []).filter(
    (state) => state?.session && state?.groups && state?.groupMessages,
  );
  let next = valid.length
    ? clone(
        [...valid].sort(
          (a, b) =>
            (Number(b.meta?.revision) || 0) -
            (Number(a.meta?.revision) || 0),
        )[0],
      )
    : createHostState({
        sessionId: opts.sessionId,
        title: opts.title,
        hostPeer: {
          peerId: opts.hostPeerId,
          displayName: opts.hostDisplayName,
          role: "host",
          joinedAt: Date.now(),
          colorIndex: 0,
          trip: opts.hostTrip || undefined,
        },
      });

  const roster = new Map();
  const groups = {};
  const messages = {};
  let maxRevision = Number(next.meta?.revision) || 0;
  const groupRevisions = {};

  for (const state of valid) {
    maxRevision = Math.max(maxRevision, Number(state.meta?.revision) || 0);
    for (const entry of state.roster || []) {
      roster.set(entry.peerId, {
        ...(roster.get(entry.peerId) || {}),
        ...entry,
        role: "member",
      });
    }
    for (const [chatId, chat] of Object.entries(state.groups || {})) {
      groups[chatId] = mergeChat(groups[chatId], chat);
      groupRevisions[chatId] = Math.max(
        Number(groupRevisions[chatId]) || 0,
        Number(state.meta?.groupRevisions?.[chatId]) || 0,
      );
      const byId = new Map((messages[chatId] || []).map((m) => [m.id, m]));
      for (const message of state.groupMessages?.[chatId] || []) {
        const previous = byId.get(message.id);
        byId.set(message.id, mergeMessage(previous, message));
      }
      messages[chatId] = [...byId.values()].sort(
        (a, b) => Number(a.createdAt) - Number(b.createdAt),
      );
    }
  }

  roster.set(opts.hostPeerId, {
    ...(roster.get(opts.hostPeerId) || {}),
    peerId: opts.hostPeerId,
    displayName: opts.hostDisplayName || "Host",
    role: "host",
    joinedAt: roster.get(opts.hostPeerId)?.joinedAt || Date.now(),
    colorIndex: roster.get(opts.hostPeerId)?.colorIndex ?? 0,
    trip: opts.hostTrip || roster.get(opts.hostPeerId)?.trip || undefined,
  });
  // Keep absent members; mark peers who did not offer state as offline so
  // F5 / brief disconnect during handoff does not wipe memberships or chats.
  if (opts.activePeerIds?.length) {
    const active = new Set([...opts.activePeerIds, opts.hostPeerId]);
    for (const [peerId, entry] of roster.entries()) {
      roster.set(peerId, {
        ...entry,
        online: active.has(peerId),
      });
    }
  }

  next = {
    ...next,
    session: {
      ...next.session,
      id: opts.sessionId,
      title: next.session?.title || opts.title || "Room",
      ended: false,
    },
    roster: [...roster.values()].map((entry) => ({
      ...entry,
      role: entry.peerId === opts.hostPeerId ? "host" : "member",
    })),
    groups,
    groupMessages: messages,
    meta: {
      ...(next.meta || {}),
      revision: maxRevision + 1,
      groupRevisions,
    },
  };
  return next;
}

function mergeChat(previous, incoming) {
  if (!previous) return clone(incoming);
  return {
    ...previous,
    ...incoming,
    memberPeerIds: uniqueStrings([
      ...(previous.memberPeerIds || []),
      ...(incoming.memberPeerIds || []),
    ]),
  };
}

function mergeMessage(previous, incoming) {
  if (!previous) return clone(incoming);
  const newer =
    Number(incoming.editedAt || incoming.createdAt) >=
    Number(previous.editedAt || previous.createdAt)
      ? incoming
      : previous;
  const reactionMap = new Map();
  for (const reaction of [
    ...(previous.reactions || []),
    ...(incoming.reactions || []),
  ]) {
    reactionMap.set(reaction.emoji, {
      emoji: reaction.emoji,
      peerIds: uniqueStrings([
        ...(reactionMap.get(reaction.emoji)?.peerIds || []),
        ...(reaction.peerIds || []),
      ]),
    });
  }
  return {
    ...newer,
    reactions: reactionMap.size ? [...reactionMap.values()] : newer.reactions,
    delivery: {
      ackedBy: uniqueStrings([
        ...(previous.delivery?.ackedBy || []),
        ...(incoming.delivery?.ackedBy || []),
      ]),
    },
  };
}

/** @param {Message | undefined} last */
function previewText(last) {
  if (!last) return "No messages yet";
  if (last.kind === "system") return last.text || "System";
  if (last.kind === "sticker") return "Sticker";
  if (
    last.kind === "video" ||
    looksLikeVideoInfo(last.mediaInfo, last.mediaIds?.length || 0)
  ) {
    return last.text?.trim() ? last.text : "Video";
  }
  if (
    last.kind === "audio" ||
    looksLikeAudioInfo(last.mediaInfo, last.mediaIds?.length || 0)
  ) {
    return last.text?.trim() ? last.text : "Audio";
  }
  if (
    last.kind === "file" ||
    looksLikeFileInfo(last.mediaInfo, last.mediaIds?.length || 0)
  ) {
    return last.text?.trim()
      ? last.text
      : last.mediaInfo?.[0]?.fileName || "File";
  }
  if (last.forward) {
    const body =
      last.kind === "sticker"
        ? "Sticker"
        : last.text?.trim() ||
          (last.kind === "media" || last.kind === "album"
            ? "Photo"
            : last.kind === "video"
              ? "Video"
              : last.kind === "audio"
                ? "Audio"
                : last.kind === "file"
                  ? "File"
                  : "Message");
    return `Fwd: ${body}`;
  }
  if (last.kind === "media") {
    return last.text?.trim() ? last.text : "Photo";
  }
  if (last.kind === "album") {
    return last.text?.trim() ? last.text : "Album";
  }
  return last.text || "Message";
}

/** @param {unknown} raw @returns {string[]} */
function normalizeMediaIds(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const ids = [];
  for (const id of raw) {
    const s = String(id || "").trim();
    if (s && !ids.includes(s)) ids.push(s);
  }
  return ids;
}

/**
 * @param {unknown} raw
 * @param {number} len
 * @returns {{ size: number, mime?: string, duration?: number, width?: number, height?: number, thumbDataUrl?: string, fileName?: string }[] | undefined}
 */
function normalizeMediaInfo(raw, len) {
  if (!Array.isArray(raw) || !len) return undefined;
  /** @type {{ size: number, mime?: string, duration?: number, width?: number, height?: number, thumbDataUrl?: string, fileName?: string }[]} */
  const out = [];
  for (let i = 0; i < len; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object") continue;
    const size = Number(/** @type {{ size?: number }} */ (item).size) || 0;
    const thumbRaw = /** @type {{ thumbDataUrl?: string }} */ (item).thumbDataUrl;
    const thumbDataUrl =
      typeof thumbRaw === "string" &&
      thumbRaw.startsWith("data:image/") &&
      thumbRaw.length < 120_000
        ? thumbRaw
        : undefined;
    const nameRaw = /** @type {{ fileName?: string }} */ (item).fileName;
    const fileName =
      typeof nameRaw === "string" && nameRaw.trim()
        ? sanitizeFileName(nameRaw)
        : undefined;
    out.push({
      size,
      mime: /** @type {{ mime?: string }} */ (item).mime,
      duration: /** @type {{ duration?: number }} */ (item).duration,
      width: /** @type {{ width?: number }} */ (item).width,
      height: /** @type {{ height?: number }} */ (item).height,
      thumbDataUrl,
      fileName,
    });
  }
  return out.length ? out : undefined;
}

/**
 * @param {{ emoji: string, peerIds: string[] }[] | undefined} reactions
 * @param {string} emoji
 * @param {string} peerId
 * @returns {{ emoji: string, peerIds: string[] }[]}
 */
function toggleReaction(reactions, emoji, peerId) {
  /** @type {{ emoji: string, peerIds: string[] }[]} */
  const list = (reactions || []).map((r) => ({
    emoji: r.emoji,
    peerIds: [...(r.peerIds || [])],
  }));
  const idx = list.findIndex((r) => r.emoji === emoji);
  if (idx < 0) {
    list.push({ emoji, peerIds: [peerId] });
    return list;
  }
  const peers = list[idx].peerIds;
  if (peers.includes(peerId)) {
    const next = peers.filter((p) => p !== peerId);
    if (!next.length) list.splice(idx, 1);
    else list[idx] = { emoji, peerIds: next };
  } else {
    list[idx] = { emoji, peerIds: [...peers, peerId] };
  }
  return list;
}

/**
 * @param {unknown} raw
 * @returns {{ fromName: string, fromPeerId?: string, originalId?: string, fromChatId?: string } | undefined}
 */
function normalizeForward(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const fromName = String(o.fromName || "").trim();
  if (!fromName) return undefined;
  return {
    fromName: fromName.slice(0, 80),
    fromPeerId: o.fromPeerId ? String(o.fromPeerId) : undefined,
    originalId: o.originalId ? String(o.originalId) : undefined,
    fromChatId: o.fromChatId ? String(o.fromChatId) : undefined,
  };
}

/**
 * @param {Message} src
 * @param {{ chatId: string, senderPeerId: string, fromName: string, fromPeerId?: string, fromChatId?: string }} ctx
 * @returns {Message}
 */
export function buildForwardedMessage(src, ctx) {
  const forward = normalizeForward({
    fromName: ctx.fromName,
    fromPeerId: ctx.fromPeerId,
    originalId: src.id,
    fromChatId: ctx.fromChatId,
  });
  /** @type {Message} */
  const msg = {
    id: mintId("m"),
    chatId: ctx.chatId,
    senderPeerId: ctx.senderPeerId,
    createdAt: Date.now(),
    kind: src.kind,
    text: src.text,
    entities: src.entities,
    sticker: src.sticker,
    mediaIds: src.mediaIds ? [...src.mediaIds] : undefined,
    mediaInfo: src.mediaInfo ? clone(src.mediaInfo) : undefined,
    forward,
    delivery: { ackedBy: [] },
  };
  return msg;
}

/**
 * Infer video when mediaKind was dropped but mime says video/*.
 * @param {{ mime?: string }[] | undefined} mediaInfo
 * @param {number} count
 */
function looksLikeVideoInfo(mediaInfo, count) {
  if (count !== 1 || !mediaInfo?.[0]?.mime) return false;
  return String(mediaInfo[0].mime).toLowerCase().startsWith("video/");
}

/**
 * @param {{ mime?: string }[] | undefined} mediaInfo
 * @param {number} count
 */
function looksLikeAudioInfo(mediaInfo, count) {
  if (count !== 1 || !mediaInfo?.[0]?.mime) return false;
  return String(mediaInfo[0].mime).toLowerCase().startsWith("audio/");
}

/**
 * Infer file when mediaKind was dropped but mime/name says document.
 * @param {{ mime?: string, fileName?: string }[] | undefined} mediaInfo
 * @param {number} count
 */
function looksLikeFileInfo(mediaInfo, count) {
  if (count !== 1 || !mediaInfo?.[0]) return false;
  const mime = String(mediaInfo[0].mime || "").toLowerCase();
  if (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/")
  ) {
    return false;
  }
  if (mediaInfo[0].fileName) return true;
  return Boolean(mime);
}

/** @param {HostState} state @param {string} peerId */
function rosterHas(state, peerId) {
  return state.roster.some((r) => r.peerId === peerId);
}

/** @param {HostState} state */
function nextColorIndex(state) {
  const used = new Set(state.roster.map((r) => r.colorIndex ?? 0));
  for (let i = 0; i < 16; i++) {
    if (!used.has(i)) return i;
  }
  return state.roster.length % 5;
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string[]} xs */
function uniqueStrings(xs) {
  return [...new Set(xs.map(String))];
}
