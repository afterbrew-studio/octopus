import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("GitHub preparation liveness", () => {
  it("heartbeats between slow preparation requests", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/indexer-prep-liveness-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("GitHub preparation liveness checks passed");
  }, 60_000);
});
