import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("repository preparation before PR review", () => {
  it("analyzes a discovered index once, waits for peers and retries failures", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/review-repository-preparation-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  });
});
