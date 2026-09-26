import { expect, it } from "bun:test";

it.skipIf(!process.env.FORGEJO_CONNECTOR_RUNTIME_TEST || !process.env.FORGEJO_CONNECTOR_TEST_DATABASE_URL)("accepts authenticated connector results above 10MB in built Next and rejects decoded overflow", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/forgejo-connector-runtime-harness.ts", import.meta.url).pathname], {
    env: { ...process.env, DATABASE_URL: process.env.FORGEJO_CONNECTOR_TEST_DATABASE_URL!, OCTOPUS_DATA_KEY: "a".repeat(64) },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, out + err).toBe(0);
}, 180_000);
