import { expect, it } from "bun:test";

it("rolls back admission when the config freeze fails, and admits cleanly on retry", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/webhook-admission-freeze-atomicity-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS a freeze failure rolls back its admission; the retry admits cleanly");
});
