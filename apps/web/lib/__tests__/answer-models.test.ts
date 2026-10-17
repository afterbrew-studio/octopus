import { expect, it } from "bun:test";

it("answers run on the configured models", async () => {
  // Isolated in its own process: module mocks are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/answer-models-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS answers run on the configured models");
});
