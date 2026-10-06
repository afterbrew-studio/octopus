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
  expect(stdout).toContain("PASS repository-preparation and low-balance deferrals stay claimable, a claim taken after the publication check cannot produce a second review, a replayed job for a finished run does not dispatch, a worker that lost its claim cannot publish or persist its failure, a worker that lost its claim while publishing cannot promote its result, an old claim cannot write to the request that replaced it, a worker that loses its claim before a provider call sends nothing, an unknown outcome is never resent and is reconciled later, a deferral that cannot be scheduled leaves the run recoverable, a review held for failing checks stays alive, is rechecked on a backoff and is never reviewed on a red build, overlapping jobs cannot cancel a run that one of them holds, a worker that lost its claim cannot release the new owner's row, preserves the run across defer-then-succeed and defer-then-fail, finalizes superseded runs on a cross-request race or a missed guarded update, treats only reviewRequestVersion (never headSha) as a legacy wildcard, and closes the binding-check-to-claim race");
});
