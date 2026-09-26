import { expect, it } from "bun:test";

it("publishes one compact summary with bounded history through the real HTTP adapter", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-summary-evidence-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
});
