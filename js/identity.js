const KEY_PREFIX = "ephchat.identity.";

/** HKDF salt/info bind the pairwise key to this app + purpose (both sides use these). */
const PAIR_SALT = new TextEncoder().encode("ephchat:pair:v1:salt");
const PAIR_INFO = new TextEncoder().encode("ephchat:pair:v1:aes-gcm");

/**
 * A session-scoped identity. The ECDSA key authenticates routed packet origins;
 * the separate ECDH key derives pairwise AES-GCM keys so relays cannot read
 * targeted payloads. The logical peerId is derived from the signing key only.
 */
export class SessionIdentity {
  /**
   * @param {CryptoKey} privateKey ECDSA signing key
   * @param {CryptoKey} publicKey ECDSA verify key
   * @param {JsonWebKey} publicJwk ECDSA public JWK
   * @param {string} peerId
   * @param {CryptoKey} ecdhPrivateKey
   * @param {JsonWebKey} ecdhPublicJwk
   */
  constructor(
    privateKey,
    publicKey,
    publicJwk,
    peerId,
    ecdhPrivateKey,
    ecdhPublicJwk,
  ) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicJwk = publicJwk;
    this.peerId = peerId;
    this.ecdhPrivateKey = ecdhPrivateKey;
    this.ecdhPublicJwk = ecdhPublicJwk;
    /** @type {Map<string, Promise<CryptoKey>>} cache of derived pairwise keys */
    this._pairKeys = new Map();
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

  /**
   * Derive (and cache) the pairwise AES-GCM key shared with a peer's ECDH key.
   * ECDH is symmetric, so both sides compute the same key.
   * @param {JsonWebKey} theirEcdhJwk
   * @returns {Promise<CryptoKey>}
   */
  deriveSharedKey(theirEcdhJwk) {
    if (!theirEcdhJwk) return Promise.reject(new Error("Missing ECDH key"));
    const cacheKey = stableJwk(theirEcdhJwk);
    let pending = this._pairKeys.get(cacheKey);
    if (!pending) {
      pending = derivePairKey(this.ecdhPrivateKey, theirEcdhJwk);
      this._pairKeys.set(cacheKey, pending);
    }
    return pending;
  }

  /**
   * Encrypt an object for a peer. Returns base64url iv + ciphertext.
   * @param {JsonWebKey} theirEcdhJwk
   * @param {unknown} value
   * @returns {Promise<{ iv: string, ct: string }>}
   */
  async seal(theirEcdhJwk, value) {
    const key = await this.deriveSharedKey(theirEcdhJwk);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      bytes,
    );
    return {
      iv: bytesToBase64Url(iv),
      ct: bytesToBase64Url(new Uint8Array(cipher)),
    };
  }

  /**
   * Decrypt a sealed payload from a peer.
   * @param {JsonWebKey} theirEcdhJwk
   * @param {{ iv: string, ct: string }} sealed
   * @returns {Promise<unknown>}
   */
  async open(theirEcdhJwk, sealed) {
    const key = await this.deriveSharedKey(theirEcdhJwk);
    const iv = base64UrlToBytes(sealed.iv);
    const ct = base64UrlToBytes(sealed.ct);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  }
}

/** @param {string} sessionId @returns {Promise<SessionIdentity>} */
export async function loadSessionIdentity(sessionId) {
  const storageKey = `${KEY_PREFIX}${sessionId}`;
  let signingPrivateJwk;
  let signingPublicJwk;
  let ecdhPrivateJwk;
  let ecdhPublicJwk;

  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw) {
      const saved = JSON.parse(raw);
      signingPrivateJwk = saved.privateJwk;
      signingPublicJwk = saved.publicJwk;
      ecdhPrivateJwk = saved.ecdhPrivateJwk;
      ecdhPublicJwk = saved.ecdhPublicJwk;
    }
  } catch {
    // Invalid or unavailable session storage: mint a fresh identity below.
  }

  if (!signingPrivateJwk || !signingPublicJwk) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    signingPrivateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    signingPublicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  }

  // Upgrade path: older records may lack an ECDH key. Mint one while keeping the
  // signing key (and therefore peerId) stable.
  if (!ecdhPrivateJwk || !ecdhPublicJwk) {
    const ecdhPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"],
    );
    ecdhPrivateJwk = await crypto.subtle.exportKey("jwk", ecdhPair.privateKey);
    ecdhPublicJwk = await crypto.subtle.exportKey("jwk", ecdhPair.publicKey);
  }

  const privateKey = await crypto.subtle.importKey(
    "jwk",
    signingPrivateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const publicKey = await importPublicKey(signingPublicJwk);
  const ecdhPrivateKey = await crypto.subtle.importKey(
    "jwk",
    ecdhPrivateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
  const peerId = await peerIdForPublicKey(signingPublicJwk);

  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        privateJwk: signingPrivateJwk,
        publicJwk: signingPublicJwk,
        ecdhPrivateJwk,
        ecdhPublicJwk,
      }),
    );
  } catch {
    // The identity remains valid for this page lifetime.
  }

  return new SessionIdentity(
    privateKey,
    publicKey,
    signingPublicJwk,
    peerId,
    ecdhPrivateKey,
    ecdhPublicJwk,
  );
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

/**
 * Encrypt an object under a raw symmetric AES-GCM key (e.g. a room key).
 * @param {CryptoKey} key
 * @param {unknown} value
 * @returns {Promise<{ iv: string, ct: string }>}
 */
export async function sealWithKey(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return {
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(new Uint8Array(cipher)),
  };
}

/**
 * Decrypt an object sealed with {@link sealWithKey}.
 * @param {CryptoKey} key
 * @param {{ iv: string, ct: string }} sealed
 * @returns {Promise<unknown>}
 */
export async function openWithKey(key, sealed) {
  const iv = base64UrlToBytes(sealed.iv);
  const ct = base64UrlToBytes(sealed.ct);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * @param {CryptoKey} myEcdhPrivateKey
 * @param {JsonWebKey} theirEcdhJwk
 * @returns {Promise<CryptoKey>}
 */
async function derivePairKey(myEcdhPrivateKey, theirEcdhJwk) {
  const theirKey = await crypto.subtle.importKey(
    "jwk",
    theirEcdhJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: theirKey },
    myEcdhPrivateKey,
    256,
  );
  const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: PAIR_SALT, info: PAIR_INFO },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
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
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJwk(jwk))),
  );
  return `p_${bytesToBase64Url(digest).slice(0, 27)}`;
}

/** Stable serialization of an EC JWK (order-independent). @param {JsonWebKey} jwk */
function stableJwk(jwk) {
  return JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
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
