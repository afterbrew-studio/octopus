import { describe, expect, it } from "bun:test";
import {
  countUsersSharingFingerprint,
  isSharedFingerprintAbuse,
  SHARED_FINGERPRINT_THRESHOLD,
} from "@/lib/device-abuse";

describe("isSharedFingerprintAbuse", () => {
  it("flags at or above the threshold, not below", () => {
    expect(isSharedFingerprintAbuse(SHARED_FINGERPRINT_THRESHOLD)).toBe(true);
    expect(isSharedFingerprintAbuse(SHARED_FINGERPRINT_THRESHOLD - 1)).toBe(false);
    expect(isSharedFingerprintAbuse(0)).toBe(false);
  });
});

describe("countUsersSharingFingerprint", () => {
  it("counts OTHER users on the fingerprint, excluding the current one", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = {
      userDevice: {
        count: (args: { where: { fingerprint: string; userId: { not: string } } }) => {
          seen = args;
          return Promise.resolve(2);
        },
      },
    };

    const n = await countUsersSharingFingerprint(client, "fp123", "me");
    expect(n).toBe(2);
    // Must exclude the current user; @@unique([userId,fingerprint]) makes a plain
    // count == distinct users, so no DISTINCT needed.
    expect(seen).toEqual({ where: { fingerprint: "fp123", userId: { not: "me" } } });
  });
});
