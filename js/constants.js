/** @type {string} Stable app id for Trystero / protocol (Phase 1+). */
export const APP_ID = "tg-githubio-ephemeral-chat";

/** @type {number} Application protocol version. */
export const APP_VERSION = 1;

/** @type {number} Framing envelope version. */
export const ENVELOPE_V = 1;

/** @type {number} Max images per album send. */
export const MAX_ALBUM_ITEMS = 10;

/** @type {number} Post-compress hard byte cap per image. */
export const MAX_IMAGE_BYTES = 512 * 1024;

/** @type {number} Longest edge after resize. */
export const MEDIA_MAX_DIMENSION = 1600;

/** @type {number} JPEG encode quality 0–1. */
export const MEDIA_JPEG_QUALITY = 0.82;

/** @type {number} Chunk size for media transfer (bytes before base64). */
export const MEDIA_CHUNK_BYTES = 16 * 1024;

/** @type {number} Host group media store budget (bytes). */
export const HOST_MEDIA_BUDGET_BYTES = 128 * 1024 * 1024;

/** @type {number} Auto-fetch / auto-play videos at or under this size. */
export const VIDEO_AUTO_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/** TURN / large-payload guidance shown on transfer failures. */
export const MEDIA_TURN_HINT =
  "Transfer failed — VPN/strict NAT often blocks large media. Try without VPN, or set localStorage ephchat.turnServers (see trystero.js).";
