import { expect, it } from "bun:test";

it("check state judges the latest run of every check, across all pages", async () => {
  // Isolated in its own process: it replaces global fetch and module mocks are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/check-state-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS check state judges the latest run of every check, all pages");
});
