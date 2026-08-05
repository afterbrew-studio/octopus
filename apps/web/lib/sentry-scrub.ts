import type { ErrorEvent } from "@sentry/nextjs";

// This app handles payment, OAuth tokens, webhook secrets, and API keys, so we
// scrub aggressively before anything leaves the process. `sendDefaultPii: false`
// already keeps Sentry from attaching cookies/headers/IP; this is belt-and-
// suspenders for anything that reaches `extra`/`contexts` via our own code.
const SENSITIVE_KEY_RX =
  /(authorization|cookie|password|secret|token|api[-_]?key|private[-_]?key|webhook[-_]?secret|access[-_]?token|client[-_]?secret|dsn|credential)/i;

function redact(value: unknown, depth = 0): unknown {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RX.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Parse a 0..1 Sentry sample rate from env, falling back on missing or invalid
 * input so a fat-fingered value can't turn into a NaN/out-of-range rate.
 */
export function parseRate(raw: string | undefined, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/** Drop request headers/cookies and redact sensitive keys from an event. */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  if (event.request) {
    delete (event.request as { cookies?: unknown }).cookies;
    delete (event.request as { headers?: unknown }).headers;
  }
  if (event.extra) event.extra = redact(event.extra) as Record<string, unknown>;
  if (event.contexts) {
    event.contexts = redact(event.contexts) as typeof event.contexts;
  }
  return event;
}
