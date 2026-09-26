import { expect, it } from "bun:test";

it("freezes a run on the Forgejo transactional admission path before enqueueing", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/forgejo-transactional-run-freeze-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS Forgejo transactional path freezes a run before enqueueing");
});
