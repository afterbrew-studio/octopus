import { mock } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ prisma: {} }));
process.env.OCTOPUS_CLAUDE_CODE_MODE = "subscription";

/**
 * The completion a review is judged on, from what the `claude` CLI itself reports as
 * its terminal result. Approval needs positive completion evidence, so an adapter
 * that never reports it can never approve.
 */

// A stand-in `claude` first on PATH, so the real adapter spawns it. The binary is never the
// real CLI: nothing here may reach a model.
const directory = mkdtempSync(join(tmpdir(), "fake-claude-"));
writeFileSync(join(directory, "claude"), '#!/bin/sh\nprintf "%s" "$FAKE_CLAUDE_STDOUT"\n');
chmodSync(join(directory, "claude"), 0o755);
process.env.PATH = `${directory}:${process.env.PATH}`;

const { claudeCodeProvider } = await import("@/lib/providers/claude-code");
const completionFor = async (result: unknown) => {
  process.env.FAKE_CLAUDE_STDOUT = typeof result === "string" ? result : JSON.stringify(result);
  return (await claudeCodeProvider.create({ model: "claude-code:sonnet", messages: [{ role: "user", content: "hi" }], maxTokens: 100 } as never)).completion;
};

assert.deepEqual(await completionFor({ type: "result", subtype: "success", is_error: false, result: "review" }),
  { state: "completed", reason: "result:success" }, "the CLI's successful terminal result is completion");
assert.equal((await completionFor({ subtype: "success", is_error: false, result: "r", stop_reason: "end_turn" }))?.state, "completed");
assert.equal((await completionFor({ subtype: "success", is_error: false, result: "r", stop_reason: "max_tokens" }))?.state, "incomplete",
  "a stop reason that is not a natural end still wins over a successful result");
assert.equal((await completionFor({ subtype: "error_max_turns", is_error: false, result: "r" }))?.state, "unknown", "a result that is not a success is not completion");
assert.equal((await completionFor({ subtype: "success", is_error: true, result: "r" }))?.state, "unknown");
assert.equal((await completionFor("plain text from an older CLI"))?.state, "unknown", "output that cannot be read as a result carries no evidence");

console.log("PASS claude cli completion follows its terminal result");
