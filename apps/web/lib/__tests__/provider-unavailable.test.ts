import { expect, it } from "bun:test";

it("the classifier reads the status and connection errors the SDKs throw", async () => {
  // Isolated in its own process: other suites replace the SDK modules process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/provider-unavailable-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS the classifier reads the status and connection errors the SDKs throw");
});
