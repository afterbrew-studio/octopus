import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("discovered repository indexing", () => {
  it("queues eligible repositories and shares claims with PR indexing", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/repository-index-job-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  });
});
