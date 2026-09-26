
import { mock } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
mock.module("server-only", () => ({}));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ appId: "123", privateKey }) }));
const { updateCheckRun } = await import("../../github");
let controller = new AbortController();
let remaining = 10000;
let mode = "cancel-auth";
let sends = 0;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (String(url).endsWith("/access_tokens")) {
    await Promise.resolve();
    if (mode === "cancel-auth") controller.abort();
    if (mode === "expire-auth") remaining = 0;
    return Response.json({ token: "synthetic" });
  }
  assert.ok(String(url).includes("/check-runs/"));
  sends++;
  if (mode === "cancel-send") {
    assert.ok(init?.signal);
    controller.abort();
    assert.equal(init.signal.aborted, true);
    init.signal.throwIfAborted();
  }
  return Response.json({});
}) as typeof fetch;
for (mode of ["cancel-auth", "expire-auth", "cancel-send"]) {
  controller = new AbortController(); remaining = 10000; sends = 0;
  await assert.rejects(updateCheckRun(1, "owner", "repo", 1, "success", { title: "Passed", summary: "5/5" },
    { jobId: "job", signal: controller.signal, deadlineEpochMs: Date.now() + 10000, remainingMs: () => remaining }));
  assert.equal(sends, mode === "cancel-send" ? 1 : 0);
}
mode = "cancel-auth"; sends = 0;
await updateCheckRun(1, "owner", "repo", 1, "failure", { title: "Failed", summary: "Unscored" });
assert.equal(sends, 1);
