import { expect, it } from "bun:test";

it("validates the configured review output budget in an isolated process", async () => {
  for (const [name, value, expected] of [
    ["unset", undefined, 8192],
    ["empty", "", 8192],
    ["override", "16384", 16384],
    ["minimum", "1", 1],
    ["maximum", "131072", 131072],
    ["zero", "0", 8192],
    ["negative", "-1", 8192],
    ["fractional", "1.5", 8192],
    ["invalid", "invalid", 8192],
    ["infinite", "Infinity", 8192],
    ["overflow", "1e309", 8192],
    ["above maximum", "131073", 8192],
  ] as const) {
    const env = { ...process.env };
    delete env.OCTOPUS_REVIEW_MAX_TOKENS;
    if (value !== undefined) env.OCTOPUS_REVIEW_MAX_TOKENS = value;
    const child = Bun.spawn(["bun", "-e", 'import { REVIEW_MAX_TOKENS } from "./lib/constants.ts"; console.log(REVIEW_MAX_TOKENS)'], {
      cwd: import.meta.dir + "/../..", env, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ name, exit, stderr, budget: stdout.trim() }).toEqual({ name, exit: 0, stderr: "", budget: String(expected) });
  }
}, 30_000);

for (const [name, value, expected] of [["default", undefined, 8192], ["override", "16384", 16384]] as const) {
  it(`preserves assessment evidence and sends the ${name} output budget`, async () => {
    const env = { ...process.env };
    delete env.OCTOPUS_REVIEW_MAX_TOKENS;
    if (value !== undefined) env.OCTOPUS_REVIEW_MAX_TOKENS = value;
    const child = Bun.spawn(["bun", "lib/__tests__/fixtures/review-assessment-harness.ts", String(expected)], {
      cwd: import.meta.dir + "/../..", env, stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("PASS adapter completion, publication and immutable request identity");
  }, 30_000);
}
