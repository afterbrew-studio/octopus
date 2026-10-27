import { describe, expect, it } from "bun:test";
import { INDEX_HEARTBEAT_INTERVAL_MS, INDEX_JOB_ABORT_MS, INDEX_JOB_EXPIRE_SECONDS, INDEX_SILENCE_LIMIT_MS, throttledHeartbeat } from "@/lib/index-liveness";

describe("throttledHeartbeat", () => {
  it("touches at most once per interval and waits a full interval after the claim", async () => {
    let clock = 1_000_000;
    let touches = 0;
    const beat = throttledHeartbeat(async () => { touches++; }, () => clock);
    await beat();
    expect(touches).toBe(0);
    clock += INDEX_HEARTBEAT_INTERVAL_MS;
    await beat();
    await beat();
    expect(touches).toBe(1);
    clock += INDEX_HEARTBEAT_INTERVAL_MS - 1;
    await beat();
    expect(touches).toBe(1);
    clock += 1;
    await beat();
    expect(touches).toBe(2);
  });

  it("surfaces a lost claim to the caller", async () => {
    let clock = 0;
    const beat = throttledHeartbeat(async () => { throw new Error("Indexing attempt is no longer current"); }, () => clock);
    clock += INDEX_HEARTBEAT_INTERVAL_MS;
    await expect(beat()).rejects.toThrow("no longer current");
  });
});

describe("index liveness timing", () => {
  it("lets many heartbeats fit inside the silence limit and aborts before expiry", () => {
    expect(INDEX_SILENCE_LIMIT_MS).toBeGreaterThanOrEqual(5 * INDEX_HEARTBEAT_INTERVAL_MS);
    expect(INDEX_JOB_ABORT_MS).toBeLessThan(INDEX_JOB_EXPIRE_SECONDS * 1000);
    expect(INDEX_JOB_EXPIRE_SECONDS).toBeGreaterThanOrEqual(3 * 3600);
  });
});
