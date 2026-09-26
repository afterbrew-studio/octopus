import { expect, it } from "bun:test";

it("preserves a frozen run's final state across a repository-preparation defer-then-succeed sequence", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-repository-preparation-lifecycle-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  // Scenario B deliberately fails a review and logs it via `console.error` --
  // stderr is not asserted empty here, unlike the harness's siblings.
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS repository-preparation deferral stays claimable, preserves the run across defer-then-succeed and defer-then-fail, finalizes superseded runs on a cross-request race or a missed guarded update, leaves a legacy run's unbound fields unchecked, and closes the binding-check-to-claim race");
});
