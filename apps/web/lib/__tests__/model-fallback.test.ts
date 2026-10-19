import { expect, it } from "bun:test";
import { Glob } from "bun";

it("a fallback model replaces an unavailable provider through the real router", async () => {
  // Isolated in its own process: module mocks and the environment are process-wide.
  const process = Bun.spawn(["bun", "lib/__tests__/fixtures/model-fallback-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  expect(stdout).toContain("PASS fallback model replaces an unavailable provider");
});

// A direct createAiMessage call skips OCTOPUS_FALLBACK_MODEL; callers go through model-fallback.
const DIRECT_CALL_ALLOWED = new Set(["lib/ai-router.ts", "lib/model-fallback.ts", "lib/reviewer.ts"]);

it("no module calls createAiMessage directly outside the allowlist", async () => {
  const root = import.meta.dir + "/../..";
  const offenders: string[] = [];
  for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (file.includes("node_modules") || file.startsWith(".next/") || file.includes("__tests__/") || DIRECT_CALL_ALLOWED.has(file)) continue;
    if (/\bcreateAiMessage\(/.test(await Bun.file(`${root}/${file}`).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
