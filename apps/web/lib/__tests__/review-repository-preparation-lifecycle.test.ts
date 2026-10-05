import { expect, it } from "bun:test";

it("preserves a frozen run's final state across a repository-preparation and low-balance defer-then-succeed sequences", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-repository-preparation-lifecycle-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  // Scenario B deliberately fails a review and logs it via `console.error` --
  // stderr is not asserted empty here, unlike the harness's siblings.
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS repository-preparation and low-balance deferrals stay claimable, a claim taken after the publication check cannot produce a second review, a replayed job for a finished run does not dispatch, a worker that lost its claim cannot publish or persist its failure, a long publication keeps its claim and an ambiguous one is reconciled before any retry, a deferral that cannot be scheduled leaves the run recoverable, preserves the run across defer-then-succeed and defer-then-fail, finalizes superseded runs on a cross-request race or a missed guarded update, treats only reviewRequestVersion (never headSha) as a legacy wildcard, and closes the binding-check-to-claim race");
});
