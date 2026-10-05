import { expect, it } from "bun:test";

it("a bounded review POST reports an unknown outcome and lists reviews strictly", async () => {
  // Isolated in its own process: it replaces global fetch and module mocks are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/github-review-publication-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS github review publication reports unknown outcomes and lists reviews strictly");
});
