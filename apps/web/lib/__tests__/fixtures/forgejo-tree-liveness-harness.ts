import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: module mocks must not reach other tests.
mock.module("server-only", () => ({}));
let clock = 1_000_000;
mock.module("@octopus/db", () => ({ prisma: { forgejoIntegration: { findUnique: async () => ({
  forgejoHost: "https://forgejo.example", accessTokenEnc: "enc", connectorTokenHash: null, username: "bot", connectorError: null,
  organization: { bannedAt: null, deletedAt: null }, id: "integration-1",
}) } } }));
mock.module("@/lib/crypto", () => ({ decryptString: () => "token" }));
mock.module("@/lib/forgejo-connector", () => ({ requestViaForgejoConnector: async () => { throw new Error("unused"); } }));
const actualHttp = await import("@/lib/forgejo-http");
const pagesRequested: string[] = [];
let hang = false;
mock.module("@/lib/forgejo-http", () => ({
  ...actualHttp,
  forgejoRequest: async (_host: string, _token: string, path: string, options?: { signal?: AbortSignal }) => {
    pagesRequested.push(path);
    if (hang) return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
    clock += 6 * 60_000;
    const page = Number(new URL(`https://x${path}`).searchParams.get("page"));
    return { body: JSON.stringify({ total_count: 3000, tree: Array.from({ length: 1000 }, (_, i) => ({ path: `p${page}/f${i}.ts`, type: "blob", mode: "100644" })) }) };
  },
}));
const { getRepositoryTree } = await import("@/lib/forgejo");
const { INDEX_SILENCE_LIMIT_MS, throttledHeartbeat } = await import("@/lib/index-liveness");

const sha = "a".repeat(40);
const touches: number[] = [];
const started = clock;
const paths = await getRepositoryTree("org-1", "acme/big", sha, { onPage: throttledHeartbeat(async () => { touches.push(clock); }, () => clock) });
assert.equal(paths.length, 3000);
assert.ok(clock - started > INDEX_SILENCE_LIMIT_MS, "the listing itself outlasts the silence limit");
assert.ok(touches.length >= 2, `a heartbeat between pages, got ${touches.length}`);
let last = started;
for (const at of touches) { assert.ok(at - last < INDEX_SILENCE_LIMIT_MS); last = at; }

pagesRequested.length = 0; hang = true;
const controller = new AbortController();
const cancelled = getRepositoryTree("org-1", "acme/big", sha, { signal: controller.signal });
await new Promise(resolve => setTimeout(resolve, 20));
controller.abort(new Error("cancelled"));
await assert.rejects(cancelled, /cancelled/);
assert.equal(pagesRequested.length, 1);
console.log("Forgejo tree liveness checks passed");
process.exit(0);
