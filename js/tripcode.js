/**
 * Secure tripcodes: a passphrase deterministically derives an Ed25519 "handle"
 * keypair. The public key yields a short, stable `!code`; the holder signs their
 * session peerId with the handle key so every client can verify - independently
 * of the (untrusted) host - that a given peerId truly owns that code.
 *
 * The Ed25519 primitives come from @noble/ed25519 loaded from a pinned CDN with
 * graceful fallback: if it cannot load (offline / blocked) or no passphrase is
 * given, handles are simply disabled and names render plainly.
 */

// Pinned like js/trystero.js and js/ui/twemoji.js.
const ED25519_CDN = "https://cdn.jsdelivr.net/npm/@noble/ed25519@2.1.0/+esm";

const PBKDF2_SALT = new TextEncoder().encode("ephchat:trip:v1");
const PBKDF2_ITERATIONS = 200_000;
const TRIP_ID_LENGTH = 10;

/** @type {Promise<object | null> | null} */
let edPromise = null;

/** @typedef {{ id: string, pub: string, sig: string }} Handle */

/** Lazy-load @noble/ed25519 once; resolves to null if unavailable. */
function loadEd() {
  if (!edPromise) {
    edPromise = import(ED25519_CDN).catch(() => null);
  }
  return edPromise;
}

/**
 * Deterministically derive this session's handle from a passphrase, binding it
 * to the current peerId via a signature.
 * @param {string} passphrase
 * @param {string} peerId
 * @returns {Promise<Handle | null>}
 */
export async function deriveHandle(passphrase, peerId) {
  const phrase = String(passphrase || "");
  if (!phrase || !peerId) return null;
  const ed = await loadEd();
  if (!ed) return null;
  try {
    const seed = await pbkdf2Seed(phrase);
    const pub = await ed.getPublicKeyAsync(seed);
    const sig = await ed.signAsync(new TextEncoder().encode(peerId), seed);
    return {
      id: await tripIdFromPub(pub),
      pub: bytesToBase64Url(pub),
      sig: bytesToBase64Url(sig),
    };
  } catch {
    return null;
  }
}

const verifyCache = new Map();

/**
 * Verify that `trip` is a well-formed handle owned by `peerId`.
 * @param {string} peerId
 * @param {Handle | undefined | null} trip
 * @returns {Promise<boolean>}
 */
export async function verifyHandle(peerId, trip) {
  if (!peerId || !trip?.id || !trip?.pub || !trip?.sig) return false;
  const cacheKey = `${peerId}:${trip.sig}`;
  if (verifyCache.has(cacheKey)) return verifyCache.get(cacheKey);
  const result = await verifyUncached(peerId, trip);
  verifyCache.set(cacheKey, result);
  return result;
}

/**
 * @param {string} peerId
 * @param {Handle} trip
 * @returns {Promise<boolean>}
 */
async function verifyUncached(peerId, trip) {
  const ed = await loadEd();
  if (!ed) return false;
  try {
    const pub = base64UrlToBytes(trip.pub);
    if ((await tripIdFromPub(pub)) !== trip.id) return false;
    return await ed.verifyAsync(
      base64UrlToBytes(trip.sig),
      new TextEncoder().encode(peerId),
      pub,
    );
  } catch {
    return false;
  }
}

/** @param {string} phrase @returns {Promise<Uint8Array>} 32-byte seed */
async function pbkdf2Seed(phrase) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(phrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    256,
  );
  return new Uint8Array(bits);
}

/** @param {Uint8Array} pub @returns {Promise<string>} short base32 code */
async function tripIdFromPub(pub) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pub));
  return base32(digest).slice(0, TRIP_ID_LENGTH);
}

// Crockford base32 (no I, L, O, U) for readable, unambiguous codes.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** @param {Uint8Array} bytes */
function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** @param {Uint8Array} bytes */
function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** @param {string} value */
function base64UrlToBytes(value) {
  const pad = value.length % 4 ? "=".repeat(4 - (value.length % 4)) : "";
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
