import { expect, it } from "bun:test";

it("freezes a run for admission's own resolved head, not the caller's (possibly null) input head", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/webhook-freeze-authoritative-head-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS freeze binds the run to admission's own resolved head, not the caller's input");
});
