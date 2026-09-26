import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
const { ForgejoResponseTooLargeError } = await import("@/lib/forgejo-http");
let details: { default_branch: string } | null = { default_branch: "main" };
const deleted: string[] = [];
const embedded: string[][] = [];
mock.module("@/lib/github", () => ({
  getInstallationToken: async () => "test-token",
  getRepositoryDetails: async () => details,
  getFileContent: async () => null,
}));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
let forgejoFailure = false;
const forgejoSha = "f".repeat(40);
mock.module("@/lib/forgejo", () => ({
  runWithForgejoRepository: async (_id: string, callback: () => Promise<unknown>) => callback(),
  getBranchHead: async () => forgejoSha,
  getRepositoryTree: async (_org: string, _name: string, ref: string) => {
    assert.equal(ref, forgejoSha);
    return [".octopusignore", "index.ts", "ignored.ts", "oversized.ts"];
  },
  getFileContent: async (_org: string, _name: string, ref: string, file: string) => {
    assert.equal(ref, forgejoSha);
    if (forgejoFailure) throw new Error("Forgejo unavailable");
    if (file === ".octopusignore") return "ignored.ts";
    if (file === "oversized.ts") throw new ForgejoResponseTooLargeError();
    assert.equal(file, "index.ts");
    return "export const greeting = 'hello';\n";
  },
}));
mock.module("@/lib/qdrant", () => ({
  ensureCollection: async () => {},
  deleteRepoChunks: async (id: string) => { deleted.push(id); },
  deleteRepoFileChunks: async () => {},
  upsertChunks: async () => {},
}));
mock.module("@/lib/embeddings", () => ({
  createEmbeddings: async (texts: string[]) => {
    embedded.push(texts);
    return texts.map(() => [0.1]);
  },
}));
const { indexRepository } = await import("@/lib/indexer");
const emptySha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const responses = new Map<string, [number, unknown]>();
const requests: string[] = [];
globalThis.fetch = mock(async (input: string | URL | Request) => {
  const url = String(input);
  requests.push(url);
  const suffix = url.replace("https://api.github.com/repos/acme/new", "");
  const [status, body] = responses.get(suffix) ?? [500, { message: `Unexpected URL: ${url}` }];
  return Response.json(body, { status });
}) as typeof fetch;

async function run(branch = "main") {
  return indexRepository("repo-1", "acme/new", branch, 123);
}
function reset() {
  responses.clear(); requests.length = 0; deleted.length = 0; embedded.length = 0;
  details = { default_branch: "main" };
  responses.set("/contributors?per_page=30", [200, []]);
}

// Empty commit: GitHub's tree 404 must be verified against the existing commit.
reset();
responses.set("/git/trees/main?recursive=1", [404, { message: "Git Repository is empty." }]);
responses.set("/commits/main", [200, { commit: { tree: { sha: emptySha } } }]);
assert.equal((await run()).totalFiles, 0);
assert.deepEqual(deleted, ["repo-1"], "empty snapshots must clear an older index");
assert.equal(embedded.length, 0, "empty trees must not be embedded");

reset();
responses.set("/git/trees/main?recursive=1", [409, { message: "Git Repository is empty." }]);
assert.equal((await run()).totalVectors, 0);

reset();
responses.set("/git/trees/main?recursive=1", [200, { tree: [] }]);
assert.equal((await run()).indexedFiles, 0);

reset();
responses.set("/git/trees/main?recursive=1", [200, {}]);
await assert.rejects(run, /Invalid repository tree response/);
assert.equal(deleted.length, 0);

reset();
responses.set("/git/trees/main?recursive=1", [404, { message: "Not Found" }]);
responses.set("/commits/main", [404, { message: "Not Found" }]);
await assert.rejects(run, /Branch 'main' not found/);
assert.equal(deleted.length, 0);

reset();
responses.set("/git/trees/main?recursive=1", [404, {}]);
responses.set("/commits/main", [200, { commit: { tree: { sha: "nonempty-tree" } } }]);
await assert.rejects(run, /no tree for existing branch/);
assert.equal(deleted.length, 0);

reset(); details = null;
responses.set("/git/trees/main?recursive=1", [404, {}]);
await assert.rejects(run, /does not have access/);
assert.equal(deleted.length, 0);

for (const status of [403, 429, 500, 409]) {
  reset(); responses.set("/git/trees/main?recursive=1", [status, { message: "Failure" }]);
  await assert.rejects(run, new RegExp(`Failed to fetch tree: ${status}`));
  assert.equal(deleted.length, 0);
}

reset();
responses.set("/git/trees/main?recursive=1", [404, {}]);
responses.set("/commits/main", [429, {}]);
await assert.rejects(run, /Failed to verify branch.*429/);

// Keep branch correction and branch names containing slashes working.
reset(); details = { default_branch: "release/main" };
responses.set("/git/trees/main?recursive=1", [404, {}]);
responses.set("/git/trees/release%2Fmain?recursive=1", [404, {}]);
responses.set("/commits/release%2Fmain", [200, { commit: { tree: { sha: emptySha } } }]);
assert.equal((await run()).resolvedDefaultBranch, "release/main");

// The same repository is indexable after its first push.
reset();
responses.set("/git/trees/main?recursive=1", [200, {
  tree: [{ path: "index.ts", type: "blob", sha: "blob-1", size: 35 }],
}]);
responses.set("/git/blobs/blob-1", [200, {
  encoding: "base64", content: Buffer.from("export const greeting = 'hello';\n").toString("base64"),
}]);
const populated = await run();
assert.equal(populated.indexedFiles, 1);
assert.ok(populated.totalVectors > 0);
assert.equal(embedded.length, 1);
console.log("14 indexing regressions passed");

reset();
const forgejoResult = await indexRepository("repo-1", "acme/new", "main", 0, undefined, undefined, "forgejo", "org-1");
assert.equal(forgejoResult.indexedFiles, 1);
assert.equal(forgejoResult.totalFiles, 4, "inventory includes files skipped by indexing limits and ignore rules");
assert.equal(requests.length, 0, "Forgejo must use its validated transport instead of GitHub or git clone");
reset(); forgejoFailure = true;
await assert.rejects(indexRepository("repo-1", "acme/new", "main", 0, undefined, undefined, "forgejo", "org-1"), /Forgejo unavailable/);
assert.equal(deleted.length, 0, "failed fetch must preserve the prior index");
