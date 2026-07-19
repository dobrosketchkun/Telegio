/**
 * Build a shareable join URL. Does not mutate the current location.
 * @param {string} sessionId
 * @param {string} [baseHref]
 * @param {string} [hostPeerId] signed logical host id (routing hint)
 * @returns {string}
 */
export function mintInviteUrl(
  sessionId,
  baseHref = location.href,
  hostPeerId = "",
) {
  const url = new URL(baseHref);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", sessionId);
  if (hostPeerId) url.searchParams.set("host", hostPeerId);
  return url.toString();
}

/** @returns {string | null} */
export function readJoinSessionId() {
  return new URLSearchParams(location.search).get("join")?.trim() || null;
}

/** @returns {string | null} */
export function readJoinHostPeerId() {
  return new URLSearchParams(location.search).get("host")?.trim() || null;
}

/** @returns {boolean} */
export function isFixtureMode() {
  return new URLSearchParams(location.search).get("fixture") === "1";
}
