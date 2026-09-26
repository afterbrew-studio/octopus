import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("GitHub repository indexing", () => {
  it("handles empty repositories without hiding access or branch failures", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/indexer-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
  });
});
