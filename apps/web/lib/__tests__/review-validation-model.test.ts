import { expect, it } from "bun:test";

it("validation runs on the review's model unless an operator pins one", async () => {
  // Isolated in its own process: module mocks and the environment are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-validation-model-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS validation runs on the review's model unless an operator pins one");
});
