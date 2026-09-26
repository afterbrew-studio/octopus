import { once } from "node:events";
import { getRedis } from "./redis";

let readyWait: Promise<unknown> | null = null;

// Shared invitation limits, imported by both the create and resend routes so
// the two endpoints enforce the same budgets against the same Redis counters.
// Each invitation (create or resend) sends a real AWS SES email, so these
// guard sender reputation and cost while staying clear of real team onboarding.
export const INVITE_USER_LIMIT = 30; // per inviter, burst window
export const INVITE_USER_WINDOW_S = 10 * 60; // 10 minutes
export const INVITE_ORG_LIMIT = 100; // per org, sustained window
export const INVITE_ORG_WINDOW_S = 24 * 60 * 60; // 24 hours
export const INVITE_ORG_PENDING_CAP = 200; // max outstanding pending invitations per org

export type RateLimitResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Fixed-window rate limiter backed by Redis (INCR + EX).
 *
 * Fails open by default; failClosed callers reject when Redis is unavailable. This
 * keeps a Redis outage from blocking legitimate traffic; the limiter is an
 * abuse guard, not a correctness dependency.
 */
export async function fixedWindowLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  failClosed = false,
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) {
    return { ok: !failClosed, remaining: failClosed ? 0 : limit, retryAfterSeconds: failClosed ? windowSeconds : 0 };
  }

  const redisKey = `rl:${key}`;
  try {
    // The shared client connects asynchronously and disables offline commands.
    // Share a bounded wait so concurrent cold requests do not stack listeners.
    if (redis.status !== "ready") {
      readyWait ??= once(redis, "ready", { signal: AbortSignal.timeout(2000) })
        .finally(() => { readyWait = null; });
      await readyWait;
    }
    const count = await redis.incr(redisKey);

    // Set the window TTL on first hit. Also re-arm it if a prior EXPIRE was
    // lost (ttl === -1 means the key exists with no expiry), so a counter can
    // never get stuck high forever.
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    } else {
      const ttl = await redis.ttl(redisKey);
      if (ttl < 0) await redis.expire(redisKey, windowSeconds);
    }

    if (count > limit) {
      let ttl = await redis.ttl(redisKey);
      if (ttl < 0) ttl = windowSeconds;
      return { ok: false, remaining: 0, retryAfterSeconds: ttl };
    }

    return { ok: true, remaining: Math.max(0, limit - count), retryAfterSeconds: 0 };
  } catch (err) {
    console.error("[rate-limit] redis error:", (err as Error).message);
    return { ok: !failClosed, remaining: failClosed ? 0 : limit, retryAfterSeconds: failClosed ? windowSeconds : 0 };
  }
}

/**
 * Build a 429 response carrying a Retry-After header (seconds).
 */
export function tooManyRequests(message: string, retryAfterSeconds: number) {
  return Response.json(
    { error: message, retryAfterSeconds },
    {
      status: 429,
      headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) },
    },
  );
}
