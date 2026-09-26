import { expect, it } from "bun:test";

it("keeps one summary through review phases and fences stale publication", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-summary-comment-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS stable summary, history, stale fencing, concurrency and failure handling");
}, 30_000);

it("reconciles only an exact marker published by the configured GitHub App", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/github-summary-reconciliation-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
});


it("fences check completion after delayed authentication and cancels requests", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/github-publication-window-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
});
