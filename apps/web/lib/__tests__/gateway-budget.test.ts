import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

const sent: Record<string, unknown>[] = [];
const constructedWith: Record<string, unknown>[] = [];
type AgentOptions = {
  headersTimeout?: number;
  bodyTimeout?: number;
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  connect?: { keepAlive?: boolean; keepAliveInitialDelay?: number };
};
const agentsBuilt: AgentOptions[] = [];

// undici does not expose an Agent's options, so a subclass records them. The
// real module is restored once the gateway has been imported, so no other file
// in the run sees the stand-in.
const realUndici = await import("undici");
mock.module("undici", () => ({
  ...realUndici,
  Agent: class extends realUndici.Agent {
    constructor(opts: AgentOptions) {
      super(opts);
      agentsBuilt.push(opts);
    }
  },
}));

mock.module("openai", () => ({
  default: class {
    constructor(opts: Record<string, unknown>) {
      constructedWith.push(opts);
    }
    chat = {
      completions: {
        create: async (params: Record<string, unknown>) => {
          sent.push(params);
          return { choices: [{ finish_reason: "stop", message: { content: "ok" } }] };
        },
      },
    };
  },
}));

// Read once at import. A value that is not the default shows the agent derives
// its limits from it rather than repeating the default.
const CONFIGURED_TIMEOUT_MS = 123_456;
const savedTimeout = process.env.GATEWAY_TIMEOUT_MS;
process.env.GATEWAY_TIMEOUT_MS = String(CONFIGURED_TIMEOUT_MS);
const { callOpenAiGateway } = await import("@/lib/providers/openai-gateway");
mock.module("undici", () => realUndici);
if (savedTimeout === undefined) delete process.env.GATEWAY_TIMEOUT_MS;
else process.env.GATEWAY_TIMEOUT_MS = savedTimeout;

/**
 * OpenAI-compatible is a shape, not a contract. Z.AI accepts
 * `max_completion_tokens` and ignores it - the reply returns `finish_reason:
 * stop` having spent whatever it liked, identical to sending no budget. Every
 * review on that endpoint therefore ran unbudgeted.
 */

const call = () =>
  callOpenAiGateway(
    { model: "opencode:glm-5.3", messages: [{ role: "user", content: "hi" }], maxTokens: 8192 } as never,
    { name: "opencode" as never, modelPrefix: "opencode:", apiBase: "https://x/v4", apiKey: "k" },
  );

describe("the budget a gateway request carries", () => {
  beforeEach(() => {
    sent.length = 0;
    constructedWith.length = 0;
  });

  it("is sent under both spellings, because endpoints disagree on the name", async () => {
    await call();
    expect(sent[0]!.max_tokens).toBe(8192);
    expect(sent[0]!.max_completion_tokens).toBe(8192);
  });

  it("still names the model with its prefix stripped", async () => {
    await call();
    expect(sent[0]!.model).toBe("glm-5.3");
  });
});

describe("the client a gateway call is made with", () => {
  beforeEach(() => {
    sent.length = 0;
    constructedWith.length = 0;
  });

  it("carries an explicit timeout rather than the SDK's ten-minute default", async () => {
    // Longer than the stuck-review watchdog, the default let the watchdog restart
    // a review while the first call was still in flight.
    await call();
    expect(typeof constructedWith[0]!.timeout).toBe("number");
    expect(constructedWith[0]!.timeout as number).toBeLessThan(600_000);
  });

  it("does not retry underneath, which would make one review several calls", async () => {
    await call();
    expect(constructedWith[0]!.maxRetries).toBe(0);
  });

  it("raises undici's own 300s header and body ceilings to the gateway timeout", async () => {
    // A non-streaming review sends no response header until the model has
    // finished. undici defaults headersTimeout AND bodyTimeout to 300s, so five
    // minutes bounded every call regardless of what the SDK timeout said - and
    // undici reports it with the same "Request timed out." text.
    await call();
    expect(constructedWith[0]!.timeout).toBe(CONFIGURED_TIMEOUT_MS);
    expect(agentsBuilt).toHaveLength(1);
    expect(agentsBuilt[0]!.headersTimeout).toBe(CONFIGURED_TIMEOUT_MS);
    expect(agentsBuilt[0]!.bodyTimeout).toBe(CONFIGURED_TIMEOUT_MS);
  });

  it("hands the SDK the agent it configured", async () => {
    const { Agent } = await import("undici");
    await call();
    const opts = constructedWith[0]!.fetchOptions as { dispatcher?: unknown } | undefined;
    expect(opts?.dispatcher).toBeInstanceOf(Agent);
  });

  it("keeps the socket alive through the silent wait a review is", async () => {
    // A long non-streaming call sends nothing either way while the vendor
    // thinks. Without keep-alive the path reaps the socket mid-wait, which is
    // `Connection error` when it fails fast and `Request timed out` when the
    // drop is silent - both seen on GLM reviews, neither on the vendor reached
    // through a proxy that already sets this.
    const { connect, keepAliveTimeout, keepAliveMaxTimeout } = agentsBuilt[0]!;
    expect(connect?.keepAlive).toBe(true);
    expect(connect?.keepAliveInitialDelay).toBeGreaterThan(0);
    expect(keepAliveTimeout).toBeGreaterThan(0);
    expect(keepAliveMaxTimeout).toBeGreaterThanOrEqual(keepAliveTimeout!);
  });
});
