import assert from "node:assert/strict";
import { mock, spyOn } from "bun:test";
import { NextRequest } from "next/server";

const closed = new WeakSet<ReadableStreamDefaultController>();
let duplicateCloses = 0;
const nativeClose = ReadableStreamDefaultController.prototype.close;
const closeSpy = spyOn(ReadableStreamDefaultController.prototype, "close").mockImplementation(function (this: ReadableStreamDefaultController) {
  if (closed.has(this)) duplicateCloses++;
  closed.add(this);
  return nativeClose.call(this);
});
let scenario = "not-found";
let fetchStarted: (() => void) | undefined;
let releaseFetch: (() => void) | undefined;
let analysisFinished: (() => void) | undefined;
const writes: Array<Record<string, unknown>> = [];
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => null } } }));
mock.module("@/lib/api-auth", () => ({ authenticateApiToken: async () => ({ org: { id: "org_1", githubInstallationId: 1 }, user: { id: "user_1" } }) }));
mock.module("@/lib/github", () => ({ getInstallationToken: async () => "test-token" }));
mock.module("@/lib/analyzer-install", () => ({ resolveAnalyzerInstallation: async () => 1 }));
mock.module("@octopus/package-analyzer", () => ({ analyzeRepositoryDependencies: async ({ onProgress }: { onProgress: (event: unknown) => void }) => {
  if (scenario === "analysis-error") throw new Error("Analysis failed");
  onProgress({ step: "analyzing", message: "Running" });
  return [];
} }));
mock.module("@octopus/db", () => ({ prisma: {
  packageAnalysis: {
    findFirst: async () => scenario === "cached" ? { id: "cached_1", results: [], analyzedFiles: [] } : null,
    create: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { id: "analysis_1" }; },
    update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); analysisFinished?.(); return {}; },
  },
  safePackage: { findMany: async () => [] },
} }));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (scenario === "cancelled" && url.endsWith("/team/repo")) {
    await new Promise<void>((resolve) => { releaseFetch = resolve; fetchStarted?.(); });
  }
  if (url.endsWith("/team/repo")) return scenario === "not-found" ? new Response(null, { status: 404 }) : Response.json({ default_branch: "main" });
  if (url.includes("/commits/")) return Response.json({ sha: "fixture-commit" });
  if (url.includes("/git/trees/")) return Response.json({ tree: scenario === "empty-tree" || scenario === "cancelled" ? [] : [{ type: "blob", path: "package.json" }] });
  if (url.includes("/contents/")) return scenario === "unreadable" ? new Response(null, { status: 404 }) : new Response('{"dependencies":{}}');
  throw new Error("unexpected fetch");
}) as typeof fetch;

const { POST } = await import("@/app/api/analyze-deps/route");
const request = () => new NextRequest("https://octopus.example/api/analyze-deps", { method: "POST", body: JSON.stringify({ repoUrl: "https://github.com/team/repo" }) });
for (const name of ["not-found", "cached", "empty-tree", "unreadable", "complete", "analysis-error"]) {
  scenario = name; writes.length = 0;
  const response = await POST(request());
  assert.equal(response.status, 200);
  const body = await response.text();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(duplicateCloses, 0, `${name}: close must run once`);
  assert.match(body, /event: (error|complete)/, name);
  if (name === "not-found" || name === "cached") assert.equal(writes.length, 0);
  else assert.equal(writes.at(-1)?.status, name === "analysis-error" ? "failed" : "completed", name);
}
scenario = "cancelled"; writes.length = 0;
const finished = new Promise<void>((resolve) => { analysisFinished = resolve; });
const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
const response = await POST(request());
await started;
const cancel = response.body!.cancel();
// Let the already-started analysis finish and persist its result after the reader leaves.
assert.ok(releaseFetch);
releaseFetch();
await cancel;
await finished;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(writes.at(-1)?.status, "completed");
closeSpy.mockRestore();
console.log("analyzer stream checks passed");
