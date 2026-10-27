import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("indexer liveness under slow operations", () => {
  it("heartbeats through a long rate-limit wait and stops when the claim is lost", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/indexer-liveness-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  });
});
