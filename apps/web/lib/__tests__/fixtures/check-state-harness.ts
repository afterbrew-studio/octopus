import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => null }));
const { checkStateFor, checkReportFor } = await import("@/lib/github");

/**
 * Whether a commit may be reviewed is judged on what its checks are now: the latest
 * run of each check, every run read, and nothing guessed from a partial list.
 */

type Run = { id: number; name: string; status: string; conclusion: string | null; started_at?: string | null; app?: { id: number } };
let runs: Run[] = [];
let combined: { state: string; statuses: unknown[] } = { state: "success", statuses: [] };
let failPage: number | null = null;
const requested: string[] = [];
globalThis.fetch = (async (url: string) => {
  requested.push(url);
  const page = Number(new URL(url).searchParams.get("page") ?? 1);
  if (url.includes("/check-runs")) {
    if (failPage === page) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100) }), { status: 200 });
  }
  return new Response(JSON.stringify(combined), { status: 200 });
}) as typeof fetch;

const state = () => checkStateFor(1, "o", "r", "c".repeat(40), "token");
const run = (id: number, name: string, conclusion: string | null, startedAt: string | null = `2026-10-06T06:${String(id % 60).padStart(2, "0")}:00Z`, status = "completed"): Run =>
  ({ id, name, status, conclusion, started_at: startedAt });
const warn = console.warn;
console.warn = () => {};

// A check that failed and was then re-run green is green: the failure is history.
runs = [run(1, "swift build + tests (macos)", "failure", "2026-10-06T06:31:00Z"), run(2, "swift build + tests (macos)", "success", "2026-10-06T06:58:00Z"), run(3, "swift build + tests (macos)", "success", "2026-10-06T07:10:00Z"), run(4, "lint", "success")];
assert.equal(await state(), "passing", "a failed run superseded by a later successful run of the same check must not block");
// The order the provider lists them in does not matter.
runs = [...runs].reverse();
assert.equal(await state(), "passing");

// A later failure after a success is a failure.
runs = [run(1, "build", "success", "2026-10-06T06:00:00Z"), run(2, "build", "failure", "2026-10-06T06:30:00Z")];
assert.equal(await state(), "failing", "a failure after a success is the check's state");

// A re-run still going is pending, whatever the attempt before it did.
runs = [run(1, "build", "failure", "2026-10-06T06:00:00Z"), run(2, "build", null, "2026-10-06T06:30:00Z", "in_progress")];
assert.equal(await state(), "pending", "a pending latest run is pending");

// Without start times, the later id is the later run.
runs = [run(9, "build", "success", null), run(5, "build", "failure", null)];
assert.equal(await state(), "passing");
runs = [run(5, "build", "success", null), run(9, "build", "failure", null)];
assert.equal(await state(), "failing");

// A different app's check of the same name is a different check, not a re-run.
runs = [{ ...run(1, "build", "failure"), app: { id: 10 } }, { ...run(2, "build", "success"), app: { id: 20 } }];
assert.equal(await state(), "failing", "same name from another app must not mask a failure");

// This app's own verdict is still never evidence about the code.
runs = [run(1, "Octopus Review", "failure"), run(2, "build", "success")];
assert.equal(await state(), "passing");

// More than one page is read in full: a failure on the third page counts.
runs = Array.from({ length: 250 }, (_, i) => run(i + 1, `check-${i}`, i === 230 ? "failure" : "success"));
requested.length = 0;
assert.equal(await state(), "failing", "a failing check beyond the first hundred must be seen");
assert.equal(requested.filter((url) => url.includes("/check-runs")).length, 3, "every page is read");
runs = Array.from({ length: 250 }, (_, i) => run(i + 1, `check-${i}`, "success"));
assert.equal(await state(), "passing");
// Exactly a page: the answer does not depend on a trailing empty page.
runs = Array.from({ length: 100 }, (_, i) => run(i + 1, `check-${i}`, "success"));
assert.equal(await state(), "passing");

// A list that cannot be read whole is not judged.
runs = Array.from({ length: 250 }, (_, i) => run(i + 1, `check-${i}`, "success"));
failPage = 2;
assert.equal(await state(), null, "a failed page is unknown, not passing");
failPage = null;
runs = Array.from({ length: 2500 }, (_, i) => run(i + 1, `check-${i}`, "success"));
assert.equal(await state(), null, "a list longer than the bound is unknown, not judged on a prefix");

// The report names what is failing, from the latest run of each check and from statuses.
runs = [run(1, "build", "failure", "2026-10-06T06:00:00Z"), run(2, "build", "success", "2026-10-06T06:30:00Z"), run(3, "lint", "failure"), run(4, "Octopus Review", "failure")];
combined = { state: "failure", statuses: [{ context: "ci/legacy", state: "error" }, { context: "ci/ok", state: "success" }] };
assert.deepEqual(await checkReportFor(1, "o", "r", "c".repeat(40), "token"), { state: "failing", failing: ["lint", "ci/legacy"] });
combined = { state: "success", statuses: [] };
assert.deepEqual(await checkReportFor(1, "o", "r", "c".repeat(40), "token"), { state: "failing", failing: ["lint"] });

// The combined status still counts, and nothing reported is not green.
runs = [run(1, "build", "success")];
combined = { state: "failure", statuses: [{}] };
assert.equal(await state(), "failing");
combined = { state: "success", statuses: [] };
runs = [];
assert.equal(await state(), null);

console.warn = warn;
console.log("PASS check state judges the latest run of every check, all pages");
