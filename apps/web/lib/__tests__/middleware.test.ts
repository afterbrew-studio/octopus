import { expect, it } from "bun:test";

it("allows anonymous visit HTTP requests while preserving route boundaries", async () => {
  // Keep handler dependency mocks isolated from other capture tests.
  const child = Bun.spawn([process.execPath, "test", "./lib/__tests__/fixtures/marketing-visit-http.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ exit, output: exit === 0 ? "" : stdout + stderr }).toEqual({ exit: 0, output: "" });
});
