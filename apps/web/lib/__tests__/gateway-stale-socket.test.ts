import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

it("the gateway retries only a connection that died before any response", async () => {
  // Production runs on Node, where fetch is undici's. Bun's fetch retries a closed pooled
  // connection on its own and ignores the dispatcher, so this runs the real gateway on Node.
  const webRoot = join(import.meta.dir, "..", "..");
  const directory = mkdtempSync(join(webRoot, ".gateway-stale-socket-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(webRoot, "lib/providers/openai-gateway.ts")],
      outdir: directory, target: "node", format: "esm", external: ["openai", "undici"],
      plugins: [{ name: "server-only-stub", setup(build) {
        build.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export {};", loader: "js" }));
      } }],
    });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const child = Bun.spawn(["node", join(webRoot, "lib/__tests__/fixtures/gateway-stale-socket-harness.mjs"), join(directory, "openai-gateway.js")], {
      cwd: webRoot, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr + stdout).toBe(0);
    expect(stdout).toContain("PASS gateway retries only a dead connection, before any response");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
