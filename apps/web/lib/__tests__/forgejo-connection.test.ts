import { expect, it } from "bun:test";
import { resolve } from "node:path";

it("Forgejo connection actions enforce organization permissions, identity continuity and credential cleanup", () => {
  const result = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "fixtures/forgejo-connection-harness.ts")], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, OCTOPUS_DATA_KEY: "a".repeat(64) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("forgejo connection checks passed");
});
