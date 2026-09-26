import { expect, it } from "bun:test";

it.skipIf(!process.env.FORGEJO_DELIVERY_TEST_DATABASE_URL)("atomically admits signed deliveries and recovers across process restarts", async () => {
  for (const phase of ["before_enqueue", "after_enqueue", "after_commit", "replay", "automatic_metadata_race", "automatic_write_race", "manual_rereview"]) {
    const child = Bun.spawn([process.execPath, new URL("./fixtures/forgejo-delivery-harness.ts", import.meta.url).pathname, phase], {
      env: { ...process.env, DATABASE_URL: process.env.FORGEJO_DELIVERY_TEST_DATABASE_URL!, ENABLE_REVIEW_WORKERS: "false" },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, phase + "\n" + err + out).toBe(0);
  }
}, 30_000);
