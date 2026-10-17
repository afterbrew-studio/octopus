import { beforeEach, describe, expect, it, mock } from "bun:test";

// Locks the free-tier daily cap: it only applies to orgs that have never
// purchased credits. The scope classifier is covered in utility-model.test.ts.

let purchaseRow: { id: string } | null;
let chargedSum: number | null;
const usageLogs: Array<Record<string, unknown>> = [];

mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ Prisma: { DbNull: null },
  prisma: {
    creditTransaction: {
      findFirst: mock(() => Promise.resolve(purchaseRow)),
    },
    aiUsage: {
      aggregate: mock(() =>
        Promise.resolve({ _sum: { chargedCostUsd: chargedSum } }),
      ),
    },
  },
}));
mock.module("../ai-usage", () => ({
  logAiUsage: mock((entry: Record<string, unknown>) => {
    usageLogs.push(entry);
    return Promise.resolve();
  }),
}));

const { checkFreeChatDailyCap, chatScopeGuardEnabled } =
  await import("../chat-guard");

describe("checkFreeChatDailyCap", () => {
  beforeEach(() => {
    purchaseRow = null;
    chargedSum = 0;
    delete process.env.CHAT_FREE_DAILY_CAP_USD;
  });

  it("exempts orgs that have purchased credits", async () => {
    purchaseRow = { id: "t1" };
    chargedSum = 999; // would be over any cap
    expect(await checkFreeChatDailyCap("org1")).toEqual({ blocked: false });
  });

  it("allows a never-paid org under the cap", async () => {
    chargedSum = 1.5; // default cap is $2
    expect(await checkFreeChatDailyCap("org1")).toEqual({ blocked: false });
  });

  it("blocks a never-paid org at/over the cap", async () => {
    chargedSum = 2.5;
    const res = await checkFreeChatDailyCap("org1");
    expect(res.blocked).toBe(true);
    if (res.blocked) {
      expect(res.capUsd).toBe(2);
      expect(res.spentUsd).toBe(2.5);
    }
  });

  it("respects the CHAT_FREE_DAILY_CAP_USD override", async () => {
    process.env.CHAT_FREE_DAILY_CAP_USD = "10";
    chargedSum = 5;
    expect(await checkFreeChatDailyCap("org1")).toEqual({ blocked: false });
  });

  it("treats null charged sums (no usage today) as zero", async () => {
    chargedSum = null;
    expect(await checkFreeChatDailyCap("org1")).toEqual({ blocked: false });
  });
});

describe("chatScopeGuardEnabled", () => {
  it("is on by default and off only with CHAT_SCOPE_GUARD=off", () => {
    delete process.env.CHAT_SCOPE_GUARD;
    expect(chatScopeGuardEnabled()).toBe(true);
    process.env.CHAT_SCOPE_GUARD = "off";
    expect(chatScopeGuardEnabled()).toBe(false);
    delete process.env.CHAT_SCOPE_GUARD;
  });
});
