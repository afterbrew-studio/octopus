import { expect, it } from "bun:test";

for (const harness of ["integration-setup-ui-harness.tsx", "integration-setup-action-harness.ts"]) {
  it(`checks provider setup behavior (${harness})`, async () => {
    const child = Bun.spawn([process.execPath, new URL(`./fixtures/${harness}`, import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, out + err).toBe(0);
  });
}
