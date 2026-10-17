import { expect, it } from "bun:test";

it("mechanical downshift follows OCTOPUS_MECHANICAL_MODEL", async () => {
  // Isolated in its own process: module mocks are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/mechanical-downshift-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS mechanical downshift follows OCTOPUS_MECHANICAL_MODEL");
});
