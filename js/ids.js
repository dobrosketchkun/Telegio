import { APP_ID } from "./constants.js";

/**
 * Mint a random 128-bit session id (invite code).
 * @returns {string}
 */
export function makeSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `r_${toBase64Url(bytes)}`;
}

/**
 * Normalize a human-entered permanent room id.
 * @param {unknown} raw
 */
export function normalizePermanentRoomId(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  if (!/^[a-z0-9_-]{3,64}$/.test(value)) {
    throw new Error(
      "Room ID must be 3–64 letters, numbers, hyphens, or underscores",
    );
  }
  return value;
}

/**
 * Derive the private Trystero namespace for a reusable room id.
 * @param {string} roomId
 */
export async function permanentSessionId(roomId) {
  const normalized = normalizePermanentRoomId(roomId);
  const input = new TextEncoder().encode(`${APP_ID}:permanent:${normalized}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `p_${toBase64Url(digest).slice(0, 32)}`;
}

/**
 * Derive the actual matchmaking topic from a session id + optional password.
 * With a password, the topic is a different value entirely, so peers who omit or
 * mistype it land in a separate empty swarm and cannot observe the real room
 * (no peer counts, chats, or ciphertext).
 * @param {string} sessionId
 * @param {string} [password]
 * @returns {Promise<string>}
 */
export async function deriveTopic(sessionId, password) {
  const pw = String(password || "");
  if (!pw) return sessionId;
  const input = new TextEncoder().encode(
    `${APP_ID}:topic:${sessionId}:${pw}`,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `t_${toBase64Url(digest).slice(0, 32)}`;
}

/**
 * Derive a room-wide AES-GCM key from the password (used to encrypt broadcast
 * frames). Returns null when no password is set.
 * @param {string} sessionId
 * @param {string} [password]
 * @returns {Promise<CryptoKey | null>}
 */
export async function deriveRoomKey(sessionId, password) {
  const pw = String(password || "");
  if (!pw) return null;
  const ikm = new TextEncoder().encode(
    `${APP_ID}:roomkey:${sessionId}:${pw}`,
  );
  const hkdf = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(`${APP_ID}:roomkey:salt`),
      info: new TextEncoder().encode("room-broadcast"),
    },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Deterministic DM id for a pair of peer ids.
 * @param {string} peerA
 * @param {string} peerB
 * @returns {string}
 */
export function dmIdFor(peerA, peerB) {
  const [a, b] = [String(peerA), String(peerB)].sort();
  return `dm:${a}:${b}`;
}

/**
 * Host-minted opaque id (messages, groups).
 * @param {string} [prefix="id"]
 * @returns {string}
 */
export function mintId(prefix = "id") {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
