import { expect, it } from "bun:test";

it("the claude CLI adapter reports completion from its terminal result", async () => {
  // Isolated in its own process: it replaces node:child_process for the whole run.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/claude-code-completion-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS claude cli completion follows its terminal result");
});
