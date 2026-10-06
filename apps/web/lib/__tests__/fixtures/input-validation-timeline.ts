import assert from "node:assert/strict";
import { mock } from "bun:test";

let signedIn = true;
let selectedOrg = "org_1";
let queries = 0;
let summaries = 0;
let writes = 0;
const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>) => {
  try { await run(); } catch (error) { failures.push(`${name}: ${error}`); }
};
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: selectedOrg }) }) }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user: { id: "user_1" } } : null } } }));
mock.module("@/lib/summarizer", () => ({ summarizeDailyReviews: async (_reviews: unknown, org: string) => { assert.equal(org, "org_1"); summaries++; return "Review summary"; } }));
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async ({ where }: { where: { userId: string; organizationId?: string; deletedAt: null } }) => {
    assert.equal(where.userId, "user_1"); assert.equal(where.deletedAt, null);
    return !where.organizationId || where.organizationId === "org_1" ? { organizationId: "org_1" } : null;
  } },
  pullRequest: { findMany: async ({ where }: { where: { repository: { organizationId: string }; updatedAt: { gte: Date; lte: Date } } }) => {
    queries++;
    assert.equal(where.repository.organizationId, "org_1");
    assert.ok(Number.isFinite(where.updatedAt.gte.getTime()));
    assert.ok(Number.isFinite(where.updatedAt.lte.getTime()));
    return [{ number: 1, title: "Change", url: "https://example.test/pr/1", author: "author", status: "completed", updatedAt: new Date("2026-10-06T12:00:00Z"), reviewBody: "Review", repository: { fullName: "org/repo", provider: "github" }, reviewIssues: [] }];
  } },
  daySummary: {
    findUnique: async ({ where }: { where: { organizationId_date: { organizationId: string; date: string } } }) => { queries++; assert.equal(where.organizationId_date.organizationId, "org_1"); assert.equal(typeof where.organizationId_date.date, "string"); return { summary: "Saved summary", prCount: 1 }; },
    upsert: async ({ create }: { create: { organizationId: string; date: string } }) => { assert.equal(create.organizationId, "org_1"); assert.equal(create.date, "2026-10-06"); writes++; },
  },
} }));
const { getWeekData, loadWeek, getDaySummary, generateDailySummary } = await import("@/app/(app)/timeline/actions");
const monday = new Date("2026-10-05T00:00:00Z");
const sunday = new Date("2026-10-11T23:59:59Z");
await check("direct unauthenticated week query", async () => {
  signedIn = false; queries = 0;
  assert.equal(await getWeekData("org_1", monday, sunday), null);
  assert.equal(queries, 0);
});
signedIn = true;
await check("direct cross-organization week query", async () => {
  queries = 0;
  assert.equal(await getWeekData("other_org", monday, sunday), null);
  assert.equal(queries, 0);
});
for (const invalid of [null, {}, [], "", "2026-02-30", "2025-02-29", "2026-13-01", "2026-10-06T12:00:00Z", "2026-1-1", "0000-01-01", "nul\0value"]) {
  for (const action of [loadWeek, getDaySummary, generateDailySummary]) {
    await check(`${action.name} malformed ${JSON.stringify(invalid)}`, async () => {
      queries = 0; summaries = 0; writes = 0;
      assert.equal(await action(invalid as string), null);
      assert.equal(queries, 0); assert.equal(summaries, 0); assert.equal(writes, 0);
    });
  }
}
for (const [org, start, end] of [[{}, monday, sunday], ["bad\0org", monday, sunday], ["org_1", new Date("0000-01-01"), new Date("0000-01-07")], ["org_1", new Date(8.64e15), new Date(8.64e15)], ["", monday, sunday], ["org_1", {}, sunday], ["org_1", new Date(NaN), sunday], ["org_1", sunday, monday], ["org_1", monday, new Date("2027-01-01")]] as const) {
  await check("malformed direct week arguments", async () => {
    queries = 0;
    assert.equal(await getWeekData(org as string, start as Date, end), null);
    assert.equal(queries, 0);
  });
}
for (const state of ["signed_out", "outsider"]) {
  signedIn = state !== "signed_out"; selectedOrg = state === "outsider" ? "other_org" : "org_1";
  for (const action of [loadWeek, getDaySummary, generateDailySummary]) {
    await check(`${action.name} ${state}`, async () => {
      queries = 0; summaries = 0; writes = 0;
      assert.equal(await action("2026-10-06"), null);
      assert.equal(queries, 0); assert.equal(summaries, 0); assert.equal(writes, 0);
    });
  }
}
signedIn = true; selectedOrg = "org_1";
await check("valid member week and summaries", async () => {
  assert.equal((await getWeekData("org_1", monday, sunday))?.totalPrs, 1);
  assert.equal((await loadWeek("2026-10-05"))?.days[0]?.items[0]?.prTitle, "Change");
  assert.equal((await getDaySummary("2024-02-29"))?.summary, "Saved summary");
  summaries = 0; writes = 0;
  assert.equal(await generateDailySummary("2026-10-06"), "Review summary");
  assert.equal(summaries, 1); assert.equal(writes, 1);
});
assert.deepEqual(failures, []);
console.log("input validation checks passed");
