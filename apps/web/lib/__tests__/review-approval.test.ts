import { expect, it } from "bun:test";

it("the ordinary review path approves only a verified, finding-free review", async () => {
  // Isolated in its own process: bun's module mocks are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-approval-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS ordinary review approval requires a verified, finding-free review");
});
