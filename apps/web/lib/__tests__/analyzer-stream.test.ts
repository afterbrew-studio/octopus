import { expect, it } from "bun:test";
import { resolve } from "node:path";

it("dependency analysis closes once on early returns and tolerates a cancelled reader", () => {
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "fixtures/analyzer-stream-harness.ts")], {
    cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("analyzer stream checks passed");
});
