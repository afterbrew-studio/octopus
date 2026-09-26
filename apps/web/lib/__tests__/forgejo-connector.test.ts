import { expect, it } from "bun:test";
import { resolve } from "node:path";

it.skipIf(!process.env.FORGEJO_CONNECTOR_TEST_DATABASE_URL)("fences connector commands across tenants, leases, revocation and uncertain writes", async () => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "fixtures/forgejo-connector-harness.ts")], {
    cwd: resolve(import.meta.dir, "../.."),
    env: { ...process.env, DATABASE_URL: process.env.FORGEJO_CONNECTOR_TEST_DATABASE_URL!, OCTOPUS_DATA_KEY: "a".repeat(64) },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, stdout + stderr).toBe(0);
  expect(stdout).toContain("forgejo connector checks passed");
}, 90_000);
