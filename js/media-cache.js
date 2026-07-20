/**
 * Persistent cache for chat media blobs (photos/videos/audio/files) so F5 does
 * not wipe already-downloaded or self-sent media. IndexedDB with in-memory
 * fallback when unavailable.
 */

const DB_NAME = "ephchat-media";
const STORE = "entries";
/** Skip persisting enormous single files (IndexedDB quota / tab thrash). */
const MAX_PERSIST_BYTES = 80 * 1024 * 1024;

/** @type {Promise<IDBDatabase | null> | null} */
let dbPromise = null;

/**
 * @typedef {{
 *   mime: string,
 *   size: number,
 *   width?: number,
 *   height?: number,
 *   duration?: number,
 *   blob: Blob,
 *   senderPeerId?: string,
 *   chatId?: string,
 *   dmId?: string,
 * }} CachedMediaEntry
 */

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/**
 * Persist a media entry for later F5 / new-tab restore.
 * @param {string} mediaId
 * @param {CachedMediaEntry} entry
 */
export async function persistMedia(mediaId, entry) {
  if (!mediaId || !entry?.blob) return;
  if (entry.blob.size > MAX_PERSIST_BYTES) return;
  const db = await openDb();
  if (!db) return;
  const record = {
    mime: entry.mime || entry.blob.type || "application/octet-stream",
    size: entry.size || entry.blob.size,
    width: entry.width,
    height: entry.height,
    duration: entry.duration,
    blob: entry.blob,
    senderPeerId: entry.senderPeerId,
    chatId: entry.chatId,
    dmId: entry.dmId,
  };
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record, mediaId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * @param {string} mediaId
 * @returns {Promise<CachedMediaEntry | null>}
 */
export async function loadMedia(mediaId) {
  if (!mediaId) return null;
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(mediaId);
      req.onsuccess = () => {
        const row = req.result;
        if (!row?.blob) {
          resolve(null);
          return;
        }
        resolve({
          mime: row.mime || row.blob.type || "application/octet-stream",
          size: row.size || row.blob.size,
          width: row.width,
          height: row.height,
          duration: row.duration,
          blob: row.blob,
          senderPeerId: row.senderPeerId,
          chatId: row.chatId,
          dmId: row.dmId,
        });
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Load every cached media entry (for session hydrate after F5).
 * @returns {Promise<Map<string, CachedMediaEntry>>}
 */
export async function loadAllMedia() {
  /** @type {Map<string, CachedMediaEntry>} */
  const out = new Map();
  const db = await openDb();
  if (!db) return out;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        const row = cursor.value;
        if (row?.blob) {
          out.set(String(cursor.key), {
            mime: row.mime || row.blob.type || "application/octet-stream",
            size: row.size || row.blob.size,
            width: row.width,
            height: row.height,
            duration: row.duration,
            blob: row.blob,
            senderPeerId: row.senderPeerId,
            chatId: row.chatId,
            dmId: row.dmId,
          });
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  return out;
}
