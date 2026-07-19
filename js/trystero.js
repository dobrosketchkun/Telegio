import { APP_ID } from "./constants.js";
import { loadSessionIdentity } from "./identity.js";
import { deriveRoomKey } from "./ids.js";
import { MultipathRoom } from "./multipath.js";

/** Pinned Trystero MQTT strategy (jsDelivr ESM). */
export const TRYSTERO_MQTT =
  "https://cdn.jsdelivr.net/npm/@trystero-p2p/mqtt@0.25.2/+esm";

/** Pinned Trystero Nostr strategy (the default trystero package). */
export const TRYSTERO_NOSTR =
  "https://cdn.jsdelivr.net/npm/trystero@0.25.2/+esm";

/**
 * STUN servers for ICE. STUN alone often fails across VPN / strict NAT —
 * add TURN via localStorage `ephchat.turnServers` (JSON array of ICE servers)
 * or hardcode in `turnServers` below.
 */
export const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/**
 * Optional TURN relays. Example (Metered / Cloudflare / self-hosted coturn):
 * [{ urls: "turn:….example:3478", username: "…", credential: "…" }]
 */
export const turnServers = [
  // { urls: "turn:…", username: "…", credential: "…" },
];

/**
 * Read extra TURN/ICE servers from localStorage (JSON array).
 * Set in console: localStorage.setItem('ephchat.turnServers', JSON.stringify([{urls:'turn:…',username:'…',credential:'…'}]))
 * @returns {object[]}
 */
export function loadExtraIceServers() {
  try {
    const raw = localStorage.getItem("ephchat.turnServers");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Lazy-load Trystero so a CDN failure cannot break fixture mode.
 * MQTT and Nostr are joined concurrently. The returned selfId is a signed,
 * session-scoped logical ID rather than either strategy's transient ID.
 * @param {string} sessionId
 * @param {string} [password] optional room password (derives the room key)
 * @returns {Promise<{ joinRoom: Function, selfId: string }>}
 */
export async function loadTrystero(sessionId, password) {
  if (!sessionId) throw new Error("Missing session id");
  const [mqttResult, nostrResult, identity, roomKey] = await Promise.all([
    import(TRYSTERO_MQTT).catch((error) => ({ error })),
    import(TRYSTERO_NOSTR).catch((error) => ({ error })),
    loadSessionIdentity(sessionId),
    deriveRoomKey(sessionId, password),
  ]);
  const strategies = [];
  if (typeof mqttResult.joinRoom === "function") {
    strategies.push({ name: "mqtt", joinRoom: mqttResult.joinRoom });
  }
  if (typeof nostrResult.joinRoom === "function") {
    strategies.push({ name: "nostr", joinRoom: nostrResult.joinRoom });
  }
  if (!strategies.length) {
    throw new Error("MQTT and Nostr matchmaking libraries failed to load");
  }

  const joinRoom = (config, roomId, callbacks) =>
    new MultipathRoom({
      strategies,
      config,
      roomId,
      callbacks,
      identity,
      roomKey,
    });
  return { joinRoom, selfId: identity.peerId };
}

/**
 * @param {string} [password] encrypts Trystero's own SDP signaling when set
 * @returns {{ appId: string, password?: string, rtcConfig: { iceServers: object[] }, turnConfig: object[] }}
 */
export function roomConfig(password) {
  const extra = loadExtraIceServers();
  const turns = [...turnServers, ...extra];
  /** @type {{ appId: string, password?: string, rtcConfig: { iceServers: object[] }, turnConfig: object[] }} */
  const cfg = {
    appId: APP_ID,
    // Prefer turnConfig so Trystero keeps its own STUN defaults + ours.
    rtcConfig: { iceServers: [...iceServers, ...turns] },
    turnConfig: turns,
  };
  if (password) cfg.password = String(password);
  return cfg;
}
