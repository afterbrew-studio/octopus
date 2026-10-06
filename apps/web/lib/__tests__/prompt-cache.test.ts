import { expect, it } from "bun:test";
it("preserves provider switching and bills cache counters through the router and adapters", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/prompt-cache-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS provider switching");
});
