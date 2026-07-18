const ROOM_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Mint a random session id (invite code).
 * @param {number} [length=8]
 * @returns {string}
 */
export function makeSessionId(length = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ROOM_CHARS[b % ROOM_CHARS.length]).join("");
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
