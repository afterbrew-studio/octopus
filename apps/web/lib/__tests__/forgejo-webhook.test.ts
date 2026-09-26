import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("authenticates Forgejo hooks, scopes repositories and suppresses replays before admission", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/forgejo-webhook-harness.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err + out).toBe(0);
});
