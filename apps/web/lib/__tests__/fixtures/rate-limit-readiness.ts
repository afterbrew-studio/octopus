import { mock } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const redis = Object.assign(new EventEmitter(), {
  status: "connecting", count: 0, attempts: 0, expires: 0,
  async incr() {
    this.attempts++;
    if (this.status !== "ready") throw new Error("Redis is not ready");
    return ++this.count;
  },
  async expire() { this.expires++; return 1; },
  async ttl() { return 42; },
});
redis.on("error", () => {}); // Same persistent error listener as the real client.
let configured = true;
mock.module("../../redis", () => ({ getRedis: () => configured ? redis : null }));
const { fixedWindowLimit, tooManyRequests } = await import("../../rate-limit");
const rejected = { ok: false, remaining: 0, retryAfterSeconds: 60 };
const cleanup = () => {
  assert.equal(redis.listenerCount("ready"), 0);
  assert.equal(redis.listenerCount("error"), 1);
};

// Concurrent cold requests wait without executing or stacking event listeners.
const cold = Array.from({ length: 20 }, () => fixedWindowLimit("fixture", 20, 60, true));
assert.equal(redis.attempts, 0);
assert.equal(redis.listenerCount("ready"), 1);
redis.status = "ready";
redis.emit("ready");
assert.ok((await Promise.all(cold)).every(result => result.ok));
assert.equal(redis.count, 20);
assert.equal(redis.expires, 1);
cleanup();
assert.deepEqual(await fixedWindowLimit("fixture", 20, 60, true), { ok: false, remaining: 0, retryAfterSeconds: 42 });

// A reconnect error preserves each caller's policy and removes wait listeners.
const originalError = console.error;
console.error = () => {};
try {
  redis.status = "reconnecting";
  const closed = fixedWindowLimit("fixture", 20, 60, true);
  const open = fixedWindowLimit("fixture", 20, 60);
  redis.emit("error", new Error("connection unavailable"));
  assert.deepEqual(await closed, rejected);
  assert.deepEqual(await open, { ok: true, remaining: 20, retryAfterSeconds: 0 });
  cleanup();

  // No ready/error event: the bounded wait rejects without incrementing later.
  const attempts = redis.attempts;
  const started = Date.now();
  assert.deepEqual(await fixedWindowLimit("fixture", 20, 60, true), rejected);
  assert.ok(Date.now() - started < 4000);
  assert.equal(redis.attempts, attempts);
  cleanup();
  const recovery = fixedWindowLimit("fixture", 100, 60, true);
  redis.status = "ready";
  redis.emit("ready");
  assert.equal((await recovery).ok, true);
  assert.equal(redis.attempts, attempts + 1);
  cleanup();

  configured = false;
  assert.deepEqual(await fixedWindowLimit("fixture", 20, 60, true), rejected);
  assert.equal((await fixedWindowLimit("fixture", 20, 60)).ok, true);
} finally { console.error = originalError; }
const response = tooManyRequests("Visit collection temporarily unavailable", 60);
assert.equal(response.status, 429);
assert.equal(response.headers.get("Retry-After"), "60");
assert.deepEqual(await response.json(), { error: "Visit collection temporarily unavailable", retryAfterSeconds: 60 });
console.log("readiness and outage policies passed");
