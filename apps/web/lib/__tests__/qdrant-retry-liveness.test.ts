import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("Qdrant retries on the indexing paths", () => {
  it("stay inside the silence limit and stop when the attempt is cancelled", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/qdrant-retry-liveness-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Qdrant retry liveness checks passed");
  }, 60_000);
});
