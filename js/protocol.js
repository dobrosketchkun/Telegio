import { ENVELOPE_V } from "./constants.js";

export const ROOM_CONTROL_TYPES = new Set([
  "room-presence",
  "host-claim",
  "state-handoff-request",
  "state-handoff",
]);

/**
 * @typedef {"none" | "signed" | "sealed" | "sealed+signed"} CryptoMode
 *
 * @typedef {{
 *   mode: CryptoMode,
 *   keyId?: string,
 *   alg?: string,
 *   nonce?: string,
 *   ciphertext?: string,
 *   signature?: string,
 *   signKeyId?: string,
 * }} CryptoFields
 *
 * @typedef {{
 *   v: number,
 *   type: string,
 *   crypto: CryptoFields,
 *   body?: object,
 * }} Frame
 */

/**
 * Wrap a plaintext inner payload. v1 always uses crypto.mode = "none".
 * @param {string} type
 * @param {object} [body]
 * @returns {Frame}
 */
export function encodeFrame(type, body = {}) {
  return {
    v: ENVELOPE_V,
    type,
    crypto: { mode: "none" },
    body,
  };
}

/**
 * Permanent-room control packets are signed by MultipathRoom's logical source
 * identity. This inner frame remains plaintext so it can use the normal chat
 * action while its outer packet authenticates the sender.
 */
export function encodeRoomControlFrame(type, body = {}) {
  if (!ROOM_CONTROL_TYPES.has(type)) {
    throw new Error(`Unknown room control frame: ${type}`);
  }
  return encodeFrame(type, body);
}

export function isRoomControlFrame(type) {
  return ROOM_CONTROL_TYPES.has(type);
}

/**
 * Unwrap a frame. Fail closed if mode !== "none".
 * Extra crypto fields are ignored when mode is "none".
 * @param {unknown} frame
 * @returns {{ type: string, body: object }}
 */
export function decodeFrame(frame) {
  if (!frame || typeof frame !== "object") {
    throw new Error("Invalid frame: not an object");
  }
  const f = /** @type {Frame} */ (frame);
  if (typeof f.type !== "string" || !f.type) {
    throw new Error("Invalid frame: missing type");
  }
  const mode = f.crypto?.mode ?? "none";
  if (mode !== "none") {
    throw new Error(`Unsupported crypto mode: ${mode}`);
  }
  const body =
    f.body && typeof f.body === "object" && !Array.isArray(f.body) ? f.body : {};
  return { type: f.type, body };
}

/**
 * Round-trip self-check for boot asserts.
 * @returns {boolean}
 */
export function selfCheckEnvelope() {
  const encoded = encodeFrame("action", {
    action: { type: "send-text", chatId: "g_test", text: "hi" },
  });
  if (encoded.crypto.mode !== "none") return false;
  const decoded = decodeFrame(encoded);
  return (
    decoded.type === "action" &&
    decoded.body.action?.type === "send-text" &&
    decoded.body.action?.text === "hi"
  );
}
