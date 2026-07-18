/**
 * Tab refresh resume (sessionStorage). Survives reload; cleared when the tab is closed.
 */

const KEY = "ephchat.resume";

/**
 * @typedef {{
 *   role: "host" | "guest",
 *   sessionId: string,
 *   displayName: string,
 *   title?: string,
 *   hostState?: object,
 *   dmState?: object,
 *   savedAt: number,
 * }} ResumeBlob
 */

/** @returns {ResumeBlob | null} */
export function loadResume() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.sessionId || !parsed?.displayName || !parsed?.role) {
      return null;
    }
    // Stale after 2 hours
    if (Date.now() - (parsed.savedAt || 0) > 2 * 60 * 60 * 1000) {
      clearResume();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** @param {ResumeBlob} blob */
export function saveResume(blob) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ ...blob, savedAt: Date.now() }),
    );
  } catch {
    /* quota / private mode */
  }
}

export function clearResume() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Replace an old host peerId with the new one across host state (after host refresh).
 * @param {object} hostState
 * @param {string} oldPeerId
 * @param {string} newPeerId
 * @param {string} displayName
 */
export function remapHostPeer(hostState, oldPeerId, newPeerId, displayName) {
  if (!hostState || !oldPeerId || !newPeerId) return hostState;
  if (oldPeerId === newPeerId) return hostState;
  const next = structuredClone
    ? structuredClone(hostState)
    : JSON.parse(JSON.stringify(hostState));
  next.roster = (next.roster || []).map((r) => {
    if (r.peerId !== oldPeerId) return r;
    return {
      ...r,
      peerId: newPeerId,
      displayName: displayName || r.displayName,
      role: "host",
    };
  });
  if (!next.roster.some((r) => r.peerId === newPeerId)) {
    next.roster.unshift({
      peerId: newPeerId,
      displayName: displayName || "Host",
      role: "host",
      joinedAt: Date.now(),
      colorIndex: 0,
    });
  }
  for (const chat of Object.values(next.groups || {})) {
    chat.memberPeerIds = (chat.memberPeerIds || []).map((p) =>
      p === oldPeerId ? newPeerId : p,
    );
    if (!chat.memberPeerIds.includes(newPeerId)) {
      chat.memberPeerIds = [newPeerId, ...chat.memberPeerIds];
    }
  }
  for (const list of Object.values(next.groupMessages || {})) {
    for (const msg of list) {
      if (msg.senderPeerId === oldPeerId) msg.senderPeerId = newPeerId;
    }
  }
  next.session = { ...next.session, ended: false };
  return next;
}

/**
 * Remap DM keys/members after a guest refresh (new Trystero peerId).
 * @param {object} dmState
 * @param {string} oldPeerId
 * @param {string} newPeerId
 */
export function remapDmPeer(dmState, oldPeerId, newPeerId) {
  if (!dmState || !oldPeerId || !newPeerId || oldPeerId === newPeerId) {
    return dmState || { dms: {}, dmMessages: {} };
  }
  const next = { dms: {}, dmMessages: {} };
  for (const [id, chat] of Object.entries(dmState.dms || {})) {
    if (!chat.memberPeerIds?.includes(oldPeerId)) {
      next.dms[id] = chat;
      next.dmMessages[id] = dmState.dmMessages?.[id] || [];
      continue;
    }
    const other = chat.memberPeerIds.find((p) => p !== oldPeerId);
    if (!other) continue;
    const sorted = [newPeerId, other].sort();
    const dmId = `dm:${sorted[0]}:${sorted[1]}`;
    next.dms[dmId] = {
      ...chat,
      id: dmId,
      memberPeerIds: sorted,
    };
    next.dmMessages[dmId] = (dmState.dmMessages?.[id] || []).map((m) => ({
      ...m,
      chatId: dmId,
      senderPeerId:
        m.senderPeerId === oldPeerId ? newPeerId : m.senderPeerId,
    }));
  }
  return next;
}
