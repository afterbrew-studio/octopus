import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

describe("repository onboarding controls", () => {
  it("preserves disabled automatic reviews after one-off review preparation", async () => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/review-follow-up-harness.ts", import.meta.url)), "--preserve-auto-review"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("PASS one-off review preparation preserves disabled automatic reviews");
  });
  for (const name of ["repository-controls-actions-harness.ts", "repository-controls-render-harness.tsx"]) {
    it(name.includes("actions") ? "enforces permissions and reports rejected index requests" : "renders saved review settings and provider-specific recovery", async () => {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
    });
  }
});
