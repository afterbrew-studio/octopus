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
type DeviceFinder = {
  userDevice: {
    findMany(args: {
      where: { fingerprint: string; userId: { not: string } };
      select: { userId: true };
      distinct: ["userId"];
    }): Promise<{ userId: string }[]>;
  };
};

/**
 * Count distinct OTHER users that have reported this device fingerprint.
 * Uses the global fingerprint index; excludes the current user.
 */
export async function countUsersSharingFingerprint(
  client: DeviceFinder,
  fingerprint: string,
  excludeUserId: string,
): Promise<number> {
  const rows = await client.userDevice.findMany({
    where: { fingerprint, userId: { not: excludeUserId } },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.length;
}

/** Whether a shared-fingerprint count crosses the flag threshold. */
export function isSharedFingerprintAbuse(sharedUserCount: number): boolean {
  return sharedUserCount >= SHARED_FINGERPRINT_THRESHOLD;
}
