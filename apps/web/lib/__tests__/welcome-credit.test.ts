import { describe, expect, it, mock } from "bun:test";
import { scoreSignup, WELCOME_RISK, logWelcomeOutcome } from "@/lib/welcome-credit";

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

// B2: silent withholds must become visible in the logs. Guards which cases emit
// the greppable "[welcome-credit] welcome bonus NOT granted" warning.
describe("logWelcomeOutcome", () => {
  function withWarnSpy(fn: (calls: unknown[][]) => void) {
    const spy = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = spy as unknown as typeof console.warn;
    try {
      fn(spy.mock.calls);
    } finally {
      console.warn = orig;
    }
  }

  it("logs a risk-withheld first-org bonus with cause=risk_withheld", () => {
    withWarnSpy((calls) => {
      logWelcomeOutcome({
        userId: "u1",
        orgId: "o1",
        firstOrg: true,
        granted: false,
        decision: { eligible: true, grant: false, score: 50, reason: "ip_velocity_5" },
      });
      expect(calls.length).toBe(1);
      const payload = calls[0][1] as { cause: string; score: number | null; reason: string | null };
      expect(payload.cause).toBe("risk_withheld");
      expect(payload.score).toBe(50);
      expect(payload.reason).toBe("ip_velocity_5");
    });
  });

  it("labels a lost one-time claim as cause=claim_race (grant was intended)", () => {
    withWarnSpy((calls) => {
      logWelcomeOutcome({
        userId: "u2",
        orgId: "o2",
        firstOrg: true,
        granted: false,
        decision: { eligible: true, grant: true, score: 0, reason: null },
      });
      expect(calls.length).toBe(1);
      expect((calls[0][1] as { cause: string }).cause).toBe("claim_race");
    });
  });

  it("does not log when the bonus was granted", () => {
    withWarnSpy((calls) => {
      logWelcomeOutcome({
        userId: "u3",
        orgId: "o3",
        firstOrg: true,
        granted: true,
        decision: { eligible: true, grant: true, score: 0, reason: null },
      });
      expect(calls.length).toBe(0);
    });
  });

  it("does not log for a non-first org (nothing was ever owed)", () => {
    withWarnSpy((calls) => {
      logWelcomeOutcome({
        userId: "u4",
        orgId: "o4",
        firstOrg: false,
        granted: false,
        decision: { eligible: false, grant: false, score: null, reason: null },
      });
      expect(calls.length).toBe(0);
    });
  });
});
