import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("merged-PR index job", () => {
  it("marks a partial or incomplete update stale instead of fresh", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/incremental-index-job-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Incremental index job checks passed");
  }, 60_000);
});
