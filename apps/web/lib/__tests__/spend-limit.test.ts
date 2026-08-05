import { describe, it, expect, mock, beforeEach } from "bun:test";

// getOrgSpendLimitStatus reaches prisma + the review-model/provider resolvers.
// Mock those before importing cost.ts. Mock fns close over these mutable vars so
// each test can set the org, the effective review provider, and monthly usage.
type OrgRow = {
  type: number;
  anthropicApiKey: string | null;
  openaiApiKey: string | null;
  googleApiKey: string | null;
  cohereApiKey: string | null;
  grokApiKey: string | null;
  openrouterApiKey: string | null;
  claudeCodeApiKey: string | null;
  claudeCodeAuthMode: string | null;
  monthlySpendLimitUsd: number | null;
  creditBalance: number;
  freeCreditBalance: number;
};

let org: OrgRow;
let provider = "anthropic";
let providerThrows = false;
let usageRows: Array<{ model: string; _sum: Record<string, number> }> = [];

function baseOrg(overrides: Partial<OrgRow> = {}): OrgRow {
  return {
    type: 1, // standard (credit-gated)
    anthropicApiKey: null,
    openaiApiKey: null,
    googleApiKey: null,
    cohereApiKey: null,
    grokApiKey: null,
    openrouterApiKey: null,
    claudeCodeApiKey: null,
    claudeCodeAuthMode: null,
    monthlySpendLimitUsd: null,
    creditBalance: 0,
    freeCreditBalance: 0,
    ...overrides,
  };
}

mock.module("@octopus/db", () => ({
  prisma: {
    organization: { findUnique: mock(async () => org) },
    aiUsage: { groupBy: mock(async () => usageRows) },
    // getModelPricing falls back to FALLBACK_PRICING when the DB list is empty.
    availableModel: { findMany: mock(async () => []), findFirst: mock(async () => null) },
  },
}));
mock.module("@/lib/ai-client", () => ({
  getReviewModel: mock(async () => "claude-opus-4-8"),
}));
mock.module("@/lib/ai-router", () => ({
  getProviderForModel: mock(async () => {
    if (providerThrows) throw new Error("provider resolution boom");
    return provider;
  }),
}));

import { getOrgSpendLimitStatus } from "@/lib/cost";

beforeEach(() => {
  org = baseOrg();
  provider = "anthropic";
  providerThrows = false;
  usageRows = [];
});

describe("getOrgSpendLimitStatus — BYOK admission (B4)", () => {
  it("exempts an org that has its own key for the provider it actually uses", async () => {
    org = baseOrg({ anthropicApiKey: "sk-ant", creditBalance: 0, freeCreditBalance: 0 });
    provider = "anthropic";
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: false });
  });

  it("does NOT exempt when the org's only key is for a provider it does not use", async () => {
    org = baseOrg({ openaiApiKey: "sk-oai", creditBalance: 0, freeCreditBalance: 0 });
    provider = "anthropic"; // review uses anthropic, but org only brought an openai key
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: true, reason: "no_credits" });
  });

  it("exempts operator-infra providers (ollama) regardless of keys", async () => {
    org = baseOrg({ creditBalance: 0, freeCreditBalance: 0 });
    provider = "ollama";
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: false });
  });

  it("falls back to the strict all-provider check when provider resolution throws", async () => {
    providerThrows = true;
    // Has all three keys → still exempt via fallback.
    org = baseOrg({ anthropicApiKey: "a", openaiApiKey: "o", googleApiKey: "g", creditBalance: 0 });
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: false });

    // Missing a key + no credits → blocked (fallback is strict).
    providerThrows = true;
    org = baseOrg({ anthropicApiKey: "a", creditBalance: 0, freeCreditBalance: 0 });
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: true, reason: "no_credits" });
  });
});

describe("getOrgSpendLimitStatus — credit vs cap discrimination (B1 source of truth)", () => {
  it("returns reason=no_credits when total balance is <= 0 and no BYOK key", async () => {
    org = baseOrg({ creditBalance: 0, freeCreditBalance: 0 });
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: true, reason: "no_credits" });
  });

  it("is not blocked with a positive balance and no monthly cap", async () => {
    org = baseOrg({ creditBalance: 10, freeCreditBalance: 0 });
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: false });
  });

  it("returns reason=spend_limit when a positive-balance org exceeds its monthly cap", async () => {
    org = baseOrg({ creditBalance: 100, freeCreditBalance: 0, monthlySpendLimitUsd: 1 });
    // ~$30 of platform-billed usage this month (1M output tokens on opus-4-8
    // fallback pricing $25/M × 1.2 markup) blows the $1 cap.
    usageRows = [
      { model: "claude-opus-4-8", _sum: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ];
    const res = await getOrgSpendLimitStatus("o");
    expect(res.blocked).toBe(true);
    expect(res).toMatchObject({ reason: "spend_limit" });
  });

  it("exempts community orgs from the credit gate entirely", async () => {
    org = baseOrg({ type: 2, creditBalance: 0, freeCreditBalance: 0 });
    expect(await getOrgSpendLimitStatus("o")).toEqual({ blocked: false });
  });
});
