export const JIFENG_MATCH_LEASE_MS = 5 * 60 * 1000;

export function isJifengMatchLeaseExpired(
  lockedAt: Date | string | null,
  now: Date,
) {
  if (lockedAt === null) return true;
  const timestamp = lockedAt instanceof Date
    ? lockedAt.getTime()
    : new Date(lockedAt).getTime();
  return !Number.isFinite(timestamp) ||
    timestamp + JIFENG_MATCH_LEASE_MS <= now.getTime();
}
