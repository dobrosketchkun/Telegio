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

/**
 * @param {HostState} state
 * @param {object} action
 * @param {{ actorPeerId: string }} ctx
 * @returns {{ ok: true, state: HostState } | { ok: false, error: string }}
 */
export function applyHost(state, action, ctx) {
  if (!action || typeof action.type !== "string") {
    return { ok: false, error: "Missing action type" };
  }
  if (state.session.ended) {
    return { ok: false, error: "Session ended" };
  }

  const actor = ctx.actorPeerId;
  const next = clone(state);

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
      return { ok: true, state: next };
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
      return { ok: true, state: next };
    }

    default:
      return { ok: false, error: `Unknown host action: ${action.type}` };
  }
}

/**
 * @param {DmState} dmState
 * @param {string} selfPeerId
 * @param {object} action
 * @returns {{ ok: true, state: DmState } | { ok: false, error: string }}
 */
export function applyDm(dmState, selfPeerId, action) {
  if (!action || typeof action.type !== "string") {
    return { ok: false, error: "Missing action type" };
  }
  const next = clone(dmState);

  switch (action.type) {
    case "dm-open": {
      const otherPeerId = action.peerId || action.otherPeerId;
      if (!otherPeerId || otherPeerId === selfPeerId) {
        return { ok: false, error: "Invalid DM peer" };
      }
      const dmId = dmIdFor(selfPeerId, otherPeerId);
      if (!next.dms[dmId]) {
        next.dms[dmId] = {
          id: dmId,
          type: "dm",
          memberPeerIds: [selfPeerId, otherPeerId].sort(),
          createdBy: selfPeerId,
          createdAt: Date.now(),
        };
        next.dmMessages[dmId] = [];
      }
      return { ok: true, state: next };
    }

    case "dm-send-text": {
      const dmId = action.dmId || action.chatId;
      const text = String(action.text ?? "");
      if (!dmId || !next.dms[dmId]) {
        return { ok: false, error: "Unknown DM" };
      }
      const chat = next.dms[dmId];
      if (!chat.memberPeerIds.includes(selfPeerId)) {
        return { ok: false, error: "Not a DM participant" };
      }
      if (!text.trim()) {
        return { ok: false, error: "Empty message" };
      }
      const msg = {
        id: mintId("m"),
        chatId: dmId,
        senderPeerId: selfPeerId,
        createdAt: Date.now(),
        kind: "text",
        text,
        replyTo: action.replyTo,
      };
      next.dmMessages[dmId] = [...(next.dmMessages[dmId] || []), msg];
      return { ok: true, state: next };
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
 * @returns {Array<{
 *   id: string,
 *   kind: "group" | "dm",
 *   title: string,
 *   preview: string,
 *   updatedAt: number,
 *   memberPeerIds: string[],
 * }>}
 */
export function listChatsForUi(hostState, dmState, selfPeerId) {
  /** @type {ReturnType<typeof listChatsForUi>} */
  const items = [];

  for (const chat of Object.values(hostState.groups)) {
    if (!chat.memberPeerIds.includes(selfPeerId)) continue;
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
 * @returns {{ chat: Chat, messages: Message[], kind: "group" | "dm" } | null}
 */
export function getChatThread(hostState, dmState, chatId) {
  if (hostState.groups[chatId]) {
    return {
      kind: "group",
      chat: hostState.groups[chatId],
      messages: hostState.groupMessages[chatId] || [],
    };
  }
  if (dmState.dms[chatId]) {
    return {
      kind: "dm",
      chat: dmState.dms[chatId],
      messages: dmState.dmMessages[chatId] || [],
    };
  }
  return null;
}

/**
 * Assert host JSON cannot contain DM store contents.
 * @param {HostState} hostState
 * @param {DmState} dmState
 * @returns {{ ok: true } | { ok: false, error: string }}
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

/** @param {HostState} state @param {string} peerId */
function rosterHas(state, peerId) {
  return state.roster.some((r) => r.peerId === peerId);
}

/** @template T @param {T} value @returns {T} */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** @param {string[]} xs */
function uniqueStrings(xs) {
  return [...new Set(xs.map(String))];
}
