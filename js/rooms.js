export const HOST_GRACE_MS = 30_000;

/** @param {Iterable<string>} ids */
export function pickElectionWinner(ids) {
  return [...new Set(ids)]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))[0] || null;
}

/**
 * Positive means a wins, negative means b wins.
 * Higher term wins; equal terms use the lower logical host id.
 */
export function compareHostClaims(a, b) {
  const termDifference = Number(a?.term || 0) - Number(b?.term || 0);
  if (termDifference) return termDifference;
  const aId = String(a?.hostId || "");
  const bId = String(b?.hostId || "");
  if (aId === bId) return 0;
  if (!aId) return -1;
  if (!bId) return 1;
  return aId.localeCompare(bId) < 0 ? 1 : -1;
}

/** @param {object} resume @param {string} roomId @param {number} [now] */
export function canRestorePermanentRoom(resume, roomId, now = Date.now()) {
  return Boolean(
    resume?.roomMode === "permanent" &&
      resume?.permanentRoomId === roomId &&
      Number(resume?.leaseExpiry) > now,
  );
}

/** @param {number} lastClaimAt @param {number} now */
export function isHostLeaseExpired(lastClaimAt, now) {
  return now - lastClaimAt >= HOST_GRACE_MS;
}
