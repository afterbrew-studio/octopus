import { expect, it } from "bun:test";

it("creates the run atomically with admission, rolling back both on failure and resolving a concurrent create conflict to already_in_progress", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/webhook-admission-freeze-atomicity-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS the run is created atomically with admission; a failure rolls back the pull request too, and a concurrent create conflict resolves to already_in_progress");
});
