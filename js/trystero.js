import { APP_ID } from "./constants.js";

/** Pinned Trystero MQTT strategy (jsDelivr ESM). */
export const TRYSTERO_MQTT =
  "https://cdn.jsdelivr.net/npm/@trystero-p2p/mqtt@0.25.2/+esm";

/**
 * STUN servers for ICE. For strict NAT / VPN, add TURN credentials here —
 * STUN-only often fails on school/corporate networks.
 */
export const iceServers = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

/** Optional TURN relays — leave empty until you have credentials. */
export const turnServers = [
  // { urls: "turn:…", username: "…", credential: "…" },
];

/**
 * Lazy-load Trystero so a CDN failure cannot break fixture mode.
 * @returns {Promise<{ joinRoom: Function, selfId: string }>}
 */
export async function loadTrystero() {
  const mod = await import(TRYSTERO_MQTT);
  if (typeof mod.joinRoom !== "function") {
    throw new Error("Online matchmaking library failed to load");
  }
  if (typeof mod.selfId !== "string" || !mod.selfId) {
    throw new Error("Online matchmaking library missing selfId");
  }
  return { joinRoom: mod.joinRoom, selfId: mod.selfId };
}

/** @deprecated use loadTrystero */
export async function loadJoinRoom() {
  const { joinRoom } = await loadTrystero();
  return joinRoom;
}

/** @returns {{ appId: string, rtcConfig: { iceServers: object[] }, turnConfig: object[] }} */
export function roomConfig() {
  return {
    appId: APP_ID,
    rtcConfig: { iceServers: [...iceServers, ...turnServers] },
    turnConfig: turnServers,
  };
}
