import { expect, it } from "bun:test";

it("waits for Redis readiness without bypassing quotas or outage policies", async () => {
  // Isolate the Redis module mock from the rest of the test suite.
  const child = Bun.spawn([process.execPath, new URL("./fixtures/rate-limit-readiness.ts", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(stdout.trim()).toBe("readiness and outage policies passed");
}, 10_000);
