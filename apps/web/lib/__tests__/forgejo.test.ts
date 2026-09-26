import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("keeps Forgejo transport, review coverage and publication tenant-scoped", async () => {
  const harness = fileURLToPath(new URL("./fixtures/forgejo-harness.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, harness], { stdout: "pipe", stderr: "pipe" });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, error).toBe(0);
  expect(output.trim()).toBe("Forgejo transport and adapter checks passed");
});
