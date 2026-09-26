import { expect, it } from "bun:test";

it("renders immutable review history and enforces membership at the page loader", async () => {
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/review-record-page-harness.tsx"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  // A parent-process deadline catches synchronous Markdown parser stalls.
  const deadline = setTimeout(() => process.kill("SIGKILL"), 5_000);
  const [exit, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]).finally(() => clearTimeout(deadline));
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("PASS protected readable review history");
}, 10_000);
