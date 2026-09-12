import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

let checkRuns: { status: string; conclusion: string | null; name: string }[] = [];



const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
  const u = String(url);
  const body = u.includes("/check-runs")
    ? { check_runs: checkRuns }
    : { state: "success", statuses: [{}] };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const { checkStateFor } = await import("@/lib/github");

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/**
 * A failed review writes `Octopus Review = failure` on the head it reviewed.
 * Counting that as a failing check means one failure blocks every retry on that
 * commit forever: the gate meant to avoid reviewing broken code instead prevents
 * the review from ever being retried.
 */

describe("the CI gate a review waits on", () => {
  beforeEach(() => {
    checkRuns = [];
  });

  it("ignores this app's own failed verdict", async () => {
    checkRuns = [
      { status: "completed", conclusion: "success", name: "tests" },
      { status: "completed", conclusion: "failure", name: "Octopus Review" },
    ];
    expect(await checkStateFor(1, "o", "r", "sha", "token")).toBe("passing");
  });

  it("ignores the large-PR variant too, which writes a different name", async () => {
    checkRuns = [
      { status: "completed", conclusion: "success", name: "tests" },
      { status: "completed", conclusion: "failure", name: "Octopus Review (Large PR)" },
    ];
    expect(await checkStateFor(1, "o", "r", "sha", "token")).toBe("passing");
  });

  it("still fails on a real check, which IS evidence about the code", async () => {
    checkRuns = [
      { status: "completed", conclusion: "failure", name: "governance + tests (linux)" },
      { status: "completed", conclusion: "failure", name: "Octopus Review" },
    ];
    expect(await checkStateFor(1, "o", "r", "sha", "token")).toBe("failing");
  });

  it("does not let its own in-progress run hold the gate pending", async () => {
    checkRuns = [
      { status: "completed", conclusion: "success", name: "tests" },
      { status: "in_progress", conclusion: null, name: "Octopus Review" },
    ];
    expect(await checkStateFor(1, "o", "r", "sha", "token")).toBe("passing");
  });

  it("still waits on a real check that has not finished", async () => {
    checkRuns = [{ status: "in_progress", conclusion: null, name: "tests" }];
    expect(await checkStateFor(1, "o", "r", "sha", "token")).toBe("pending");
  });
});
