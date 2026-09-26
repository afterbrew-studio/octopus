import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it.each(["integration-webhook-setup-harness", "integration-setup-callback-harness"])("checks setup behavior in %s", async (fixture) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL(`./fixtures/${fixture}.ts`, import.meta.url))], {
    stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("setup: passed");
});
