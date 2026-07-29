import { describe, expect, it } from "bun:test";
import { scoreSignup, WELCOME_RISK } from "@/lib/welcome-credit";

// Guards the signup abuse scorer's bands. Uses default (no-env) thresholds:
// warn peers 2 (+25), block peers 4 (+50), unverified +15, holdAt 40, blockAt 50.
describe("scoreSignup", () => {
  it("clean signup (verified, no IP peers) → allow, score 0", () => {
    const r = scoreSignup({ emailVerified: true, ipPeerCount: 0 });
    expect(r.score).toBe(0);
    expect(r.band).toBe("allow");
  });

  it("unverified email alone stays under the withhold threshold → allow", () => {
    const r = scoreSignup({ emailVerified: false, ipPeerCount: 0 });
    expect(r.score).toBe(15);
    expect(r.band).toBe("allow");
    expect(r.reasons).toContain("email_unverified");
  });

  it("a couple of IP peers alone → allow (conservative: shared office/CGNAT)", () => {
    const r = scoreSignup({ emailVerified: true, ipPeerCount: 2 });
    expect(r.score).toBe(25);
    expect(r.band).toBe("allow");
  });

  it("warn-level velocity + unverified email → hold (withhold credits)", () => {
    const r = scoreSignup({ emailVerified: false, ipPeerCount: 3 });
    expect(r.score).toBe(40);
    expect(r.band).toBe("hold");
  });

  it("block-level velocity (4+ peers) → block, reachable on its own", () => {
    const r = scoreSignup({ emailVerified: true, ipPeerCount: 5 });
    expect(r.score).toBe(50);
    expect(r.band).toBe("block");
    expect(r.reasons.some((x) => x.startsWith("ip_velocity_"))).toBe(true);
  });

  it("bands are ordered and every band is reachable with default weights", () => {
    // Sanity: max score exceeds blockAt so 'block' is not dead code.
    const max =
      WELCOME_RISK.points.emailUnverified + WELCOME_RISK.points.velocityBlock;
    expect(max).toBeGreaterThanOrEqual(WELCOME_RISK.blockAt);
    expect(WELCOME_RISK.blockAt).toBeGreaterThan(WELCOME_RISK.holdAt);
  });
});
