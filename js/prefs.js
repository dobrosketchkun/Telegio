/**
 * Local per-session UI prefs (pin / mute). Not synced.
 */

/**
 * @param {string} sessionId
 * @returns {{ pinnedChatIds: string[], mutedChatIds: string[] }}
 */
export function loadPrefs(sessionId) {
  const empty = { pinnedChatIds: [], mutedChatIds: [] };
  if (!sessionId) return empty;
  try {
    const raw = localStorage.getItem(`ephchat.prefs.${sessionId}`);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    return {
      pinnedChatIds: Array.isArray(parsed.pinnedChatIds)
        ? parsed.pinnedChatIds.map(String)
        : [],
      mutedChatIds: Array.isArray(parsed.mutedChatIds)
        ? parsed.mutedChatIds.map(String)
        : [],
    };
  } catch {
    return empty;
  }
}

/**
 * @param {string} sessionId
 * @param {{ pinnedChatIds?: string[], mutedChatIds?: string[] }} prefs
 */
export function savePrefs(sessionId, prefs) {
  if (!sessionId) return;
  try {
    localStorage.setItem(
      `ephchat.prefs.${sessionId}`,
      JSON.stringify({
        pinnedChatIds: prefs.pinnedChatIds || [],
        mutedChatIds: prefs.mutedChatIds || [],
      }),
    );
  } catch {
    /* quota */
  }
}

/**
 * @param {string} sessionId
 * @param {string} chatId
 * @returns {boolean} now pinned
 */
export function togglePinned(sessionId, chatId) {
  const prefs = loadPrefs(sessionId);
  const set = new Set(prefs.pinnedChatIds);
  if (set.has(chatId)) set.delete(chatId);
  else set.add(chatId);
  prefs.pinnedChatIds = [...set];
  savePrefs(sessionId, prefs);
  return set.has(chatId);
}

/**
 * @param {string} sessionId
 * @param {string} chatId
 * @returns {boolean} now muted
 */
export function toggleMuted(sessionId, chatId) {
  const prefs = loadPrefs(sessionId);
  const set = new Set(prefs.mutedChatIds);
  if (set.has(chatId)) set.delete(chatId);
  else set.add(chatId);
  prefs.mutedChatIds = [...set];
  savePrefs(sessionId, prefs);
  return set.has(chatId);
}

/** @param {string} sessionId @param {string} chatId */
export function isPinned(sessionId, chatId) {
  return loadPrefs(sessionId).pinnedChatIds.includes(chatId);
}

/** @param {string} sessionId @param {string} chatId */
export function isMuted(sessionId, chatId) {
  return loadPrefs(sessionId).mutedChatIds.includes(chatId);
}

/**
 * Global (not per-session) UI layout prefs: sidebar width + collapsed rail.
 * @returns {{ sidebarWidth: number | null, sidebarCollapsed: boolean }}
 */
export function loadUiPrefs() {
  const empty = { sidebarWidth: null, sidebarCollapsed: false };
  try {
    const raw = localStorage.getItem("ephchat.ui");
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const w = Number(parsed.sidebarWidth);
    return {
      sidebarWidth: Number.isFinite(w) && w > 0 ? w : null,
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
    };
  } catch {
    return empty;
  }
}

/**
 * @param {{ sidebarWidth?: number | null, sidebarCollapsed?: boolean }} patch
 */
export function saveUiPrefs(patch) {
  try {
    const current = loadUiPrefs();
    const next = { ...current, ...patch };
    localStorage.setItem(
      "ephchat.ui",
      JSON.stringify({
        sidebarWidth: next.sidebarWidth ?? null,
        sidebarCollapsed: Boolean(next.sidebarCollapsed),
      }),
    );
  } catch {
    /* quota */
  }
}
