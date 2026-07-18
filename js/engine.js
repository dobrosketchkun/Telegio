import { APP_ID, APP_VERSION } from "./constants.js";
import { dmIdFor, mintId } from "./ids.js";

/**
 * @typedef {{ peerId: string, displayName: string, role: "host" | "member", joinedAt: number, colorIndex?: number }} RosterEntry
 * @typedef {{ id: string, type: "dm" | "group", title?: string, memberPeerIds: string[], createdBy: string, createdAt: number }} Chat
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   senderPeerId: string,
 *   createdAt: number,
 *   editedAt?: number,
 *   kind: "text" | "sticker" | "media" | "album" | "system",
 *   text?: string,
 *   entities?: unknown[],
 *   replyTo?: string,
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
 * @typedef {{ event: string, chatId?: string, chat?: Chat, message?: Message, messageId?: string, memberPeerIds?: string[] }} Effect
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
    meta: {},
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

/**
 * Groups + messages visible to a peer. Host admin sees all groups.
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
    if (!chat.memberPeerIds.includes(peerId)) continue;
    groups[id] = chat;
    groupMessages[id] = snap.groupMessages[id] || [];
  }
  return { ...snap, groups, groupMessages };
}

/**
 * @param {HostState} state
 * @param {Omit<RosterEntry, "joinedAt" | "colorIndex" | "role"> & { role?: "member", colorIndex?: number }} peer
 * @returns {HostState}
 */
export function addRosterPeer(state, peer) {
  if (rosterHas(state, peer.peerId)) return state;
  const next = clone(state);
  next.roster.push({
    peerId: peer.peerId,
    displayName: peer.displayName,
    role: "member",
    joinedAt: Date.now(),
    colorIndex: peer.colorIndex ?? nextColorIndex(next),
  });
  return next;
}

/**
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
  for (const [id, chat] of Object.entries(next.groups)) {
    if (chat.memberPeerIds.length < 2) {
      delete next.groups[id];
      delete next.groupMessages[id];
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
      const memberPeerIds = uniqueStrings([
        actor,
        ...(Array.isArray(action.memberPeerIds) ? action.memberPeerIds : []),
      ]);
      if (memberPeerIds.length < 2) {
        return { ok: false, error: "Group needs at least 2 members" };
      }
      for (const pid of memberPeerIds) {
        if (!rosterHas(next, pid)) {
          return { ok: false, error: `Unknown peer: ${pid}` };
        }
      }
      const id = mintId("g");
      const chat = {
        id,
        type: "group",
        title,
        memberPeerIds,
        createdBy: actor,
        createdAt: Date.now(),
      };
      next.groups[id] = chat;
      next.groupMessages[id] = [];
      effects.push({ event: "chat-created", chat });
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
      const msg = {
        id: mintId("m"),
        chatId,
        senderPeerId: actor,
        createdAt: Date.now(),
        kind: "text",
        text,
        replyTo: action.replyTo,
      };
      next.groupMessages[chatId] = [...(next.groupMessages[chatId] || []), msg];
      effects.push({ event: "message-added", chatId, message: msg });
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
      if (!isHostPeer(next, actor)) {
        return { ok: false, error: "Only host can delete groups" };
      }
      const members = [...next.groups[chatId].memberPeerIds];
      delete next.groups[chatId];
      delete next.groupMessages[chatId];
      effects.push({ event: "chat-deleted", chatId, memberPeerIds: members });
      return { ok: true, state: next, effects };
    }

    case "leave-group": {
      const chatId = action.chatId;
      if (!chatId || !next.groups[chatId]) {
        return { ok: false, error: "Unknown group" };
      }
      const chat = next.groups[chatId];
      if (!chat.memberPeerIds.includes(actor)) {
        return { ok: false, error: "Not a group member" };
      }
      if (isHostPeer(next, actor)) {
        return { ok: false, error: "Host cannot leave groups; delete instead" };
      }
      const previousMembers = [...chat.memberPeerIds];
      chat.memberPeerIds = chat.memberPeerIds.filter((p) => p !== actor);
      if (chat.memberPeerIds.length < 2) {
        delete next.groups[chatId];
        delete next.groupMessages[chatId];
        effects.push({
          event: "chat-deleted",
          chatId,
          memberPeerIds: previousMembers,
        });
      } else {
        effects.push({ event: "chat-created", chat: clone(chat) });
      }
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
  const event = body.event;
  switch (event) {
    case "chat-created": {
      const chat = body.chat;
      if (!chat?.id) return next;
      next.groups[chat.id] = chat;
      if (!next.groupMessages[chat.id]) next.groupMessages[chat.id] = [];
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
    default:
      return next;
  }
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
          }
        : {
            id: mintId("m"),
            chatId: dmId,
            senderPeerId,
            createdAt: Date.now(),
            kind: "text",
            text,
            replyTo: action.replyTo,
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

  for (const chat of Object.values(hostState.groups)) {
    if (!asHost && !chat.memberPeerIds.includes(selfPeerId)) continue;
    const msgs = hostState.groupMessages[chat.id] || [];
    const last = msgs[msgs.length - 1];
    items.push({
      id: chat.id,
      kind: "group",
      title: chat.title || "Group",
      preview: last?.text || "No messages yet",
      updatedAt: last?.createdAt || chat.createdAt,
      memberPeerIds: chat.memberPeerIds,
    });
  }

  for (const chat of Object.values(dmState.dms)) {
    if (!chat.memberPeerIds.includes(selfPeerId)) continue;
    const otherId = chat.memberPeerIds.find((p) => p !== selfPeerId);
    const other = hostState.roster.find((r) => r.peerId === otherId);
    const msgs = dmState.dmMessages[chat.id] || [];
    const last = msgs[msgs.length - 1];
    items.push({
      id: chat.id,
      kind: "dm",
      title: other?.displayName || otherId || "DM",
      preview: last?.text || "No messages yet",
      updatedAt: last?.createdAt || chat.createdAt,
      memberPeerIds: chat.memberPeerIds,
    });
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
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
