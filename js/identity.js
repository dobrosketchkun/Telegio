const KEY_PREFIX = "ephchat.identity.";

/**
 * A session-scoped signing identity. It authenticates routed packet origins but
 * deliberately does not encrypt packet contents.
 */
export class SessionIdentity {
  /**
   * @param {CryptoKey} privateKey
   * @param {CryptoKey} publicKey
   * @param {JsonWebKey} publicJwk
   * @param {string} peerId
   */
  constructor(privateKey, publicKey, publicJwk, peerId) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicJwk = publicJwk;
    this.peerId = peerId;
  }

  /** @param {unknown} value */
  async sign(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      this.privateKey,
      bytes,
    );
    return bytesToBase64Url(new Uint8Array(signature));
  }
}

/** @param {string} sessionId @returns {Promise<SessionIdentity>} */
export async function loadSessionIdentity(sessionId) {
  const storageKey = `${KEY_PREFIX}${sessionId}`;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      const privateKey = await crypto.subtle.importKey(
        "jwk",
        saved.privateJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign"],
      );
      const publicKey = await importPublicKey(saved.publicJwk);
      const peerId = await peerIdForPublicKey(saved.publicJwk);
      return new SessionIdentity(
        privateKey,
        publicKey,
        saved.publicJwk,
        peerId,
      );
    }
  } catch {
    // Invalid or unavailable session storage: mint a fresh identity.
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const peerId = await peerIdForPublicKey(publicJwk);
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ privateJwk, publicJwk }),
    );
  } catch {
    // The identity remains valid for this page lifetime.
  }
  return new SessionIdentity(pair.privateKey, pair.publicKey, publicJwk, peerId);
}

/**
 * Verify that a public key owns peerId and signed value.
 * @param {string} peerId
 * @param {JsonWebKey} publicJwk
 * @param {unknown} value
 * @param {string} signature
 */
export async function verifySignedValue(
  peerId,
  publicJwk,
  value,
  signature,
) {
  if (!peerId || !publicJwk || !signature) return false;
  try {
    if ((await peerIdForPublicKey(publicJwk)) !== peerId) return false;
    const key = await importPublicKey(publicJwk);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlToBytes(signature),
      bytes,
    );
  } catch {
    return false;
  }
}

/** @param {JsonWebKey} jwk */
async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
}

/** @param {JsonWebKey} jwk */
async function peerIdForPublicKey(jwk) {
  const stable = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable)),
  );
  return `p_${bytesToBase64Url(digest).slice(0, 27)}`;
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
  const binary = atob(
    value.replace(/-/g, "+").replace(/_/g, "/") + pad,
  );
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
