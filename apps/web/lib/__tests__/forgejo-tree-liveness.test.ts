import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("Forgejo tree listing liveness", () => {
  it("heartbeats between pages and stops when cancelled", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/forgejo-tree-liveness-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Forgejo tree liveness checks passed");
  }, 60_000);
});
