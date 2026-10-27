import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("local upload liveness", () => {
  it("heartbeats through a slow batch and stops when the upload is superseded", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/index-local-liveness-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Local upload liveness checks passed");
  }, 60_000);
});
