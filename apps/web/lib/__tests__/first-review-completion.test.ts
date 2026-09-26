import { expect, it } from "bun:test";

it("records the first successful ordinary review only after final publication", async () => {
  const child = Bun.spawn([process.execPath, "lib/__tests__/fixtures/review-follow-up-harness.ts", "--first-review-completion"], {
    cwd: new URL("../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout).toContain("PASS first review completion follows final publication and survives reruns");
});
