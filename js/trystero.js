import { APP_ID } from "./constants.js";

/** Pinned Trystero MQTT strategy (jsDelivr ESM). */
export const TRYSTERO_MQTT =
  "https://cdn.jsdelivr.net/npm/@trystero-p2p/mqtt@0.25.2/+esm";

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
  const extra = loadExtraIceServers();
  const turns = [...turnServers, ...extra];
  return {
    appId: APP_ID,
    // Prefer turnConfig so Trystero keeps its own STUN defaults + ours.
    rtcConfig: { iceServers: [...iceServers, ...turns] },
    turnConfig: turns,
  };
}
