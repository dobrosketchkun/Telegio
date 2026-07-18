import { ENVELOPE_V } from "./constants.js";

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
