import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("verification queries", () => {
  it("embed with the repository's model, the one the repository was indexed and is searched with", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/review-validation-embedding-harness.ts", import.meta.url))], {
      cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("Verification embedding model checks passed");
  }, 60_000);
});
