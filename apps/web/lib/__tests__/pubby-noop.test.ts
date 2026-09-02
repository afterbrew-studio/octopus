import { describe, expect, it, beforeEach, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * On an install with no Pubby the `!` assertions in the client do not throw, so every
 * `trigger` reached the API with an undefined app id and came back 500. The caller fires
 * and forgets, so nothing broke; what broke was the logs. A self-hosted deployment
 * recorded one failure per review forever, and a real outage would have been
 * indistinguishable from that steady state.
 */

const triggered: unknown[][] = [];
mock.module("@getpubby/sdk/server", () => ({
  PubbyServer: class {
    async trigger(...args: unknown[]) {
      triggered.push(args);
      return "sent";
    }
    authenticatePrivateChannel() {
      return "private";
    }
    authenticatePresenceChannel() {
      return "presence";
    }
  },
}));

const load = async (configured: boolean) => {
  for (const key of ["PUBBY_APP_ID", "PUBBY_APP_KEY", "PUBBY_APP_SECRET"]) {
    if (configured) process.env[key] = "x";
    else delete process.env[key];
  }
  // Fresh import: PUBBY_ENABLED is computed once, at module load.
  return import(`@/lib/pubby?${configured ? "on" : "off"}`);
};

describe("pubby", () => {
  beforeEach(() => {
    triggered.length = 0;
  });

  it("does not reach the API when Pubby is not configured", async () => {
    const { pubby, PUBBY_ENABLED } = await load(false);
    expect(PUBBY_ENABLED).toBe(false);
    await pubby.trigger("channel", "event", { a: 1 });
    expect(triggered).toEqual([]);
  });

  it("still triggers when it is configured", async () => {
    // The guard test. Without it, a wrapper that swallowed every call would satisfy the
    // assertion above just as happily.
    const { pubby, PUBBY_ENABLED } = await load(true);
    expect(PUBBY_ENABLED).toBe(true);
    await pubby.trigger("channel", "event", { a: 1 });
    expect(triggered.length).toBe(1);
  });

  it("leaves channel authentication alone, because failing is the right answer there", async () => {
    // With no Pubby there is nothing to join. A silent success would leave the browser
    // waiting on a subscription it will never receive.
    const { pubby } = await load(false);
    expect(pubby.authenticatePrivateChannel).toBeDefined();
    expect(pubby.authenticatePresenceChannel).toBeDefined();
  });
});
