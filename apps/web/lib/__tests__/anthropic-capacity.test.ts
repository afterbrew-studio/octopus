import { expect, it } from "bun:test";

it("admits only a measured, preserved, current complete request and archives typed refusals", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/anthropic-capacity-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-platform-key", PLATFORM_MARKUP: "1.2", PROMPT_CACHE_TTL: "1h" },
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS measured admission, immutable refusals, cost and cancellation");
});
