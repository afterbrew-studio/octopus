/**
 * Device-fingerprint abuse detection.
 *
 * A single device fingerprint appearing across many distinct accounts is a
 * strong multi-account (Sybil) signal. Fingerprints are captured post-auth on
 * app load (client `DeviceReporter` → POST /api/auth/device), so this runs
 * retroactively at device-report time — it flags for visibility, it does not
 * move credits. Enforcement (withhold / clawback) is a separate, deliberate step.
 */

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Distinct OTHER accounts sharing a fingerprint at/above which we flag. */
export const SHARED_FINGERPRINT_THRESHOLD = envInt("SHARED_FP_THRESHOLD", 3);

/** Minimal client shape — satisfied by the Prisma client. */
type DeviceCounter = {
  userDevice: {
    count(args: {
      where: { fingerprint: string; userId: { not: string } };
    }): Promise<number>;
  };
};

/**
 * Count distinct OTHER users that have reported this device fingerprint.
 *
 * UserDevice is `@@unique([userId, fingerprint])`, so there is at most one row
 * per (user, fingerprint) — a plain row count over other users already equals
 * the distinct-user count, no DISTINCT scan needed. Uses the global fingerprint
 * index and excludes the current user.
 */
export async function countUsersSharingFingerprint(
  client: DeviceCounter,
  fingerprint: string,
  excludeUserId: string,
): Promise<number> {
  return client.userDevice.count({
    where: { fingerprint, userId: { not: excludeUserId } },
  });
}

/** Whether a shared-fingerprint count crosses the flag threshold. */
export function isSharedFingerprintAbuse(sharedUserCount: number): boolean {
  return sharedUserCount >= SHARED_FINGERPRINT_THRESHOLD;
}
