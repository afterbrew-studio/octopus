import { describe, expect, it } from "bun:test";

describe("semantic feedback suppression", () => {
  it("uses dense similarity through the real Qdrant transport and review consumers", async () => {
    const child = Bun.spawn(["bun", "lib/__tests__/fixtures/feedback-suppression-harness.ts"], {
      cwd: import.meta.dir + "/../..",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr, stdout }).toMatchObject({ exit: 0, stderr: "" });
    expect(stdout).toContain("PASS semantic feedback similarity and review consumers");
  });
});
