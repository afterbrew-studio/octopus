import { expect, it } from "bun:test";

it("preserves a frozen run's final state across a repository-preparation defer-then-succeed sequence", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-repository-preparation-lifecycle-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS repository-preparation deferral preserves the run across a defer-then-succeed sequence");
});
