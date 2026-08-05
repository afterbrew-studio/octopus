import { prisma } from "@octopus/db";

/**
 * Welcome-bonus abuse scoring.
 *
 * Disposable / no-MX emails are already blocked at signup (auth.ts
 * `user.create.before`), so the remaining native signal worth scoring at
 * grant time is Sybil velocity — many accounts from one signup IP — plus a
 * small nudge for unverified emails. Heavier IP reputation (datacenter / VPN /
 * Tor, ASN) is delivered by the maestro-fraud scoring API and plugs in here
 * later behind the same `scoreSignup` seam.
 */

/** Env-overridable so prod thresholds can be tuned without a redeploy. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export const WELCOME_RISK = {
  velocityWindowDays: envInt("WELCOME_RISK_WINDOW_DAYS", 30),
  velocityWarnPeers: envInt("WELCOME_RISK_WARN_PEERS", 2),
  velocityBlockPeers: envInt("WELCOME_RISK_BLOCK_PEERS", 4),
  points: {
    emailUnverified: envInt("WELCOME_RISK_PTS_UNVERIFIED", 15),
    velocityWarn: envInt("WELCOME_RISK_PTS_VELOCITY_WARN", 25),
    velocityBlock: envInt("WELCOME_RISK_PTS_VELOCITY_BLOCK", 50),
  },
  // Score >= holdAt withholds the bonus (signup itself is never blocked);
  // >= blockAt additionally marks it high-confidence abuse for review. Both
  // bands withhold in P1 — the split is for logging + future auto-release of
  // "hold" on step-up. blockAt is reachable by the velocity-block weight alone.
  holdAt: envInt("WELCOME_RISK_HOLD_AT", 40),
  blockAt: envInt("WELCOME_RISK_BLOCK_AT", 50),
} as const;

export type RiskBand = "allow" | "hold" | "block";

export type SignupSignals = {
  emailVerified: boolean;
  /** Other users that share this signup IP within the velocity window. */
  ipPeerCount: number;
};

export type RiskAssessment = {
  score: number;
  band: RiskBand;
  reasons: string[];
};

/** Pure additive scorer — no I/O, unit-testable. */
export function scoreSignup(s: SignupSignals): RiskAssessment {
  const { points } = WELCOME_RISK;
  let score = 0;
  const reasons: string[] = [];

  if (!s.emailVerified) {
    score += points.emailUnverified;
    reasons.push("email_unverified");
  }
  if (s.ipPeerCount >= WELCOME_RISK.velocityBlockPeers) {
    score += points.velocityBlock;
    reasons.push(`ip_velocity_${s.ipPeerCount}`);
  } else if (s.ipPeerCount >= WELCOME_RISK.velocityWarnPeers) {
    score += points.velocityWarn;
    reasons.push(`ip_velocity_${s.ipPeerCount}`);
  }

  const band: RiskBand =
    score >= WELCOME_RISK.blockAt
      ? "block"
      : score >= WELCOME_RISK.holdAt
        ? "hold"
        : "allow";
  return { score, band, reasons };
}

export type WelcomeDecision = {
  /** Bonus not yet granted to this user (leak-proof once-per-user flag). */
  eligible: boolean;
  /** eligible AND the risk band is "allow". */
  grant: boolean;
  score: number | null;
  reason: string | null;
};

/**
 * Decide whether a user's about-to-be-created first org should receive the
 * welcome bonus. Reads only — call it BEFORE the create transaction; the caller
 * still confirms first-org atomically inside the tx via `hasEverOwnedOrg`.
 *
 * Note: velocity keys on the raw signup IP, so shared egress (office NAT /
 * CGNAT) can withhold from legit users. That's why the action is WITHHOLD, not
 * a signup block — an admin can still grant, and device fingerprint (P2) will
 * disambiguate. Thresholds are env-tunable above.
 */
export async function assessWelcomeCredit(userId: string): Promise<WelcomeDecision> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, signupIp: true, welcomeGrantedAt: true },
    });

    if (!user || user.welcomeGrantedAt) {
      return { eligible: false, grant: false, score: null, reason: null };
    }

    let ipPeerCount = 0;
    if (user.signupIp) {
      const since = new Date(
        Date.now() - WELCOME_RISK.velocityWindowDays * 24 * 60 * 60 * 1000,
      );
      ipPeerCount = await prisma.user.count({
        where: { signupIp: user.signupIp, id: { not: userId }, createdAt: { gte: since } },
      });
    }

    const risk = scoreSignup({ emailVerified: user.emailVerified, ipPeerCount });
    return {
      eligible: true,
      grant: risk.band === "allow",
      score: risk.score,
      reason: risk.reasons.length ? risk.reasons.join(",") : null,
    };
  } catch (err) {
    // Scoring is best-effort. On a read failure, degrade to the pre-risk
    // behavior (grant to a genuine first org) rather than breaking signup or
    // punishing a legit user — the once-per-user cap still bounds it to one
    // bonus. Recorded so failures are visible.
    console.error("[welcome-credit] risk assessment failed, granting:", err);
    return { eligible: true, grant: true, score: null, reason: "assess_error" };
  }
}

/**
 * Emit a structured, greppable log when a first org's welcome bonus was NOT
 * granted, so silent withholds become visible in prod logs (previously the only
 * trace was `welcomeRiskScore`/`welcomeRiskReason` on the org row — no log, no
 * notice). Logging only; no behavior/threshold change. Call AFTER the create tx.
 * `cause`: `risk_withheld` (score cleared the hold band) vs `claim_race` (grant
 * was intended but a concurrent first-org create won the one-time claim).
 */
export function logWelcomeOutcome(args: {
  userId: string;
  orgId: string;
  firstOrg: boolean;
  granted: boolean;
  decision: WelcomeDecision;
}): void {
  const { userId, orgId, firstOrg, granted, decision } = args;
  if (!firstOrg || granted) return; // granted, or not a first-org attempt — nothing to flag
  console.warn("[welcome-credit] welcome bonus NOT granted to first org", {
    orgId,
    userId,
    cause: decision.grant ? "claim_race" : "risk_withheld",
    score: decision.score,
    reason: decision.reason,
  });
}
