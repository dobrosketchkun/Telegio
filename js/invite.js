/**
 * Build a shareable join URL. Does not mutate the current location.
 * @param {string} sessionId
 * @param {string} [baseHref]
 * @returns {string}
 */
export function mintInviteUrl(sessionId, baseHref = location.href) {
  const url = new URL(baseHref);
  url.search = "";
  url.hash = "";
  url.searchParams.set("join", sessionId);
  return url.toString();
}

/** @returns {string | null} */
export function readJoinSessionId() {
  return new URLSearchParams(location.search).get("join")?.trim() || null;
}

/** @returns {boolean} */
export function isFixtureMode() {
  return new URLSearchParams(location.search).get("fixture") === "1";
}
