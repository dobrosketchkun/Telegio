/**
 * Session-scoped continuity identity. Survives F5 and new tabs (localStorage)
 * so a returning browser can prove it owns the same roster slot without a
 * user-facing tripcode. Distinct from the ephemeral session peerId key.
 */

const STORAGE_PREFIX = "ephchat.cont:";

/**
 * @typedef {{ pub: string, sig: string }} ContinuityClaim
 * @typedef {{
 *   pubJwk: JsonWebKey,
 *   privateKey: CryptoKey,
 *   publicKey: CryptoKey,
 *   pub: string,
 *   signPeerId: (peerId: string) => Promise<string>,
 * }} ContinuityHandle
 */

/**
 * Load or create the continuity key for this sessionId.
 * @param {string} sessionId
 * @returns {Promise<ContinuityHandle | null>}
 */
export async function loadOrCreateContinuity(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || typeof crypto === "undefined" || !crypto.subtle) return null;
  try {
    const stored = readStored(id);
    if (stored) {
      const handle = await importStored(stored);
      if (handle) return handle;
    }
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const pubJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    writeStored(id, { pub: pubJwk, priv: privJwk });
    return makeHandle(pubJwk, pair.privateKey, pair.publicKey);
  } catch {
    return null;
  }
}

/**
 * Build a hello claim: public key + signature over the live peerId.
 * @param {ContinuityHandle} handle
 * @param {string} peerId
 * @returns {Promise<ContinuityClaim | null>}
 */
export async function claimContinuity(handle, peerId) {
  if (!handle || !peerId) return null;
  try {
    const sig = await handle.signPeerId(peerId);
    return { pub: handle.pub, sig };
  } catch {
    return null;
  }
}

/**
 * Verify that `claim` proves ownership of `peerId`.
 * @param {string} peerId
 * @param {ContinuityClaim | null | undefined} claim
 * @returns {Promise<boolean>}
 */
export async function verifyContinuity(peerId, claim) {
  if (!peerId || !claim?.pub || !claim?.sig) return false;
  try {
    const pubJwk = JSON.parse(claim.pub);
    const key = await crypto.subtle.importKey(
      "jwk",
      pubJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlToBytes(claim.sig),
      new TextEncoder().encode(peerId),
    );
  } catch {
    return false;
  }
}

/** Stable string form of a continuity public key for roster matching. */
export function continuityPubKey(claimOrPub) {
  if (!claimOrPub) return "";
  if (typeof claimOrPub === "string") return claimOrPub;
  if (typeof claimOrPub.pub === "string") return claimOrPub.pub;
  return "";
}

/** @param {string} sessionId */
function storageKey(sessionId) {
  return STORAGE_PREFIX + sessionId;
}

/** @param {string} sessionId */
function readStored(sessionId) {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.pub || !parsed?.priv) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** @param {string} sessionId @param {{ pub: JsonWebKey, priv: JsonWebKey }} value */
function writeStored(sessionId, value) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(value));
  } catch {
    /* quota / private mode */
  }
}

/** @param {{ pub: JsonWebKey, priv: JsonWebKey }} stored */
async function importStored(stored) {
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      stored.priv,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      stored.pub,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    return makeHandle(stored.pub, privateKey, publicKey);
  } catch {
    return null;
  }
}

/**
 * @param {JsonWebKey} pubJwk
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} publicKey
 * @returns {ContinuityHandle}
 */
function makeHandle(pubJwk, privateKey, publicKey) {
  const pub = JSON.stringify({
    crv: pubJwk.crv,
    kty: pubJwk.kty,
    x: pubJwk.x,
    y: pubJwk.y,
  });
  return {
    pubJwk,
    privateKey,
    publicKey,
    pub,
    async signPeerId(peerId) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(peerId),
      );
      return bytesToBase64Url(new Uint8Array(signature));
    },
  };
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
