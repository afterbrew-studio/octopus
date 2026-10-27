import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("index queue workers", () => {
  it("forwards the queue's abort signal and releases abandoned claims from the reaper", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/index-workers-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Index worker wiring checks passed");
  }, 60_000);
});
