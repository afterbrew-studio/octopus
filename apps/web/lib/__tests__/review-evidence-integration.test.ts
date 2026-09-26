import { expect, it } from "bun:test";

it("contains excluded-input claims through provider assessment, presentation, checks and immutable archives", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-evidence-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS excluded-input evidence integration");
});
