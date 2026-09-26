import { expect, it } from "bun:test";

it("the CLI review route creates an attempt", async () => {
  // Isolated in its own process: bun's module mocks are process-wide, and this
  // fixture's `@/lib/api-auth` stub must not leak into another file in the
  // same run that wants the real `authenticateApiToken` (account-standing.test.ts).
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/cli-review-attempt-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS CLI review route attempt creation");
});
