/**
 * Persistent cache for sticker image bytes pulled from peers (or fetched from
 * the sticker site). Backed by IndexedDB so cached stickers survive reloads and
 * this client can keep serving them to others. Falls back to an in-memory map
 * when IndexedDB is unavailable (private mode / old browsers).
 *
 * Only raw blobs are stored here; pack metadata (JSON) stays in localStorage via
 * js/stickers.js.
 */

import { fetchStickerBytes } from "./stickers.js";

const DB_NAME = "ephchat-stickers";
const STORE = "blobs";

/** @type {Promise<IDBDatabase | null> | null} */
let dbPromise = null;
/** In-memory fallback + fast object-URL cache. @type {Map<string, string>} */
const urlCache = new Map();
/** In-memory blob fallback when IndexedDB is unavailable. @type {Map<string, Blob>} */
const memBlobs = new Map();

/** @param {string} pack @param {string} stickerId */
export function stickerKey(pack, stickerId) {
  return `${pack}/${stickerId}`;
}

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
 * Synchronously return a ready object URL for a cached sticker, or null. Only
 * hits the in-memory map (safe to call every render).
 * @param {string} pack @param {string} stickerId
 * @returns {string | null}
 */
export function cachedStickerUrl(pack, stickerId) {
  return urlCache.get(stickerKey(pack, stickerId)) || null;
}

/**
 * Ensure an object URL exists for a cached sticker, reading IndexedDB if needed.
 * Resolves to the URL (populating the in-memory cache) or null when not cached.
 * @param {string} pack @param {string} stickerId
 * @returns {Promise<string | null>}
 */
export async function warmStickerUrl(pack, stickerId) {
  const key = stickerKey(pack, stickerId);
  const existing = urlCache.get(key);
  if (existing) return existing;
  const blob = await readBlob(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

/**
 * Store sticker bytes and make an object URL immediately available.
 * @param {string} pack @param {string} stickerId @param {Blob} blob
 * @returns {Promise<string>} the object URL
 */
export async function putSticker(pack, stickerId, blob) {
  const key = stickerKey(pack, stickerId);
  await writeBlob(key, blob);
  const prev = urlCache.get(key);
  if (prev) URL.revokeObjectURL(prev);
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  return url;
}

/**
 * Read raw sticker bytes (for serving to a peer).
 * @param {string} pack @param {string} stickerId
 * @returns {Promise<Blob | null>}
 */
export function getStickerBlob(pack, stickerId) {
  return readBlob(stickerKey(pack, stickerId));
}

/**
 * Ensure sticker bytes are in the local cache (fetch via CORS proxy if needed).
 * Call before sending so peers who can't reach the sticker site can pull from us.
 * @param {string} pack @param {string} stickerId
 * @returns {Promise<string | null>} object URL, or null on failure
 */
export async function ensureStickerCached(pack, stickerId) {
  const existing = await warmStickerUrl(pack, stickerId);
  if (existing) return existing;
  try {
    const blob = await fetchStickerBytes(pack, stickerId);
    return await putSticker(pack, stickerId, blob);
  } catch {
    return null;
  }
}

/**
 * Best-effort background fill of a pack's stickers into the cache.
 * @param {{ name: string, stickers?: Array<{ id: string }> }} pack
 * @param {number} [limit]
 */
export function warmPackCache(pack, limit = 24) {
  if (!pack?.name) return;
  const stickers = Array.isArray(pack.stickers) ? pack.stickers : [];
  for (const s of stickers.slice(0, limit)) {
    if (s?.id) ensureStickerCached(pack.name, s.id);
  }
}

/** @param {string} key @returns {Promise<Blob | null>} */
async function readBlob(key) {
  const db = await openDb();
  if (!db) return memBlobs.get(key) || null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result instanceof Blob ? req.result : null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** @param {string} key @param {Blob} blob @returns {Promise<void>} */
async function writeBlob(key, blob) {
  const db = await openDb();
  if (!db) {
    memBlobs.set(key, blob);
    return;
  }
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
