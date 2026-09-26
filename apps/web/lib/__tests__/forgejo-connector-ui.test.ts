import { expect, it } from "bun:test";

it("offers three connection paths and retains existing connector management", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/forgejo-connector-ui-harness.tsx", import.meta.url).pathname], {
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, out + err).toBe(0);
});
