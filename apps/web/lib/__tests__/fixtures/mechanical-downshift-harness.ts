import { mock } from "bun:test";
import assert from "node:assert/strict";
import { parseOctopusIgnore } from "@/lib/octopus-ignore";
import { prepareReviewInput, type ReviewCoverage, type ReviewFileInput } from "@/lib/review-coverage";

mock.module("server-only", () => ({}));

/**
 * OCTOPUS_MECHANICAL_MODEL downshifts diffs made up entirely of mechanical files even under an org
 * pin, never under a repo pin, and an unconfigured deployment keeps the built-in behaviour. Both
 * sides of a rename and policy-excluded files count towards "entirely mechanical".
 */

const MECHANICAL = "acp:MiniMax-M3";
const ORG_PIN = "opencode:glm-5.3";
const REPO_PIN = "opencode:repo-model";

let repoModel: string | null = null;
let orgModel: string | null = ORG_PIN;
mock.module("@octopus/db", () => ({
  prisma: {
    availableModel: {
      findMany: async () => [{ modelId: MECHANICAL, inputPrice: 0, outputPrice: 0 }],
      findFirst: async () => null,
    },
    repository: { findUnique: async () => ({ reviewModelId: repoModel }) },
    organization: { findUnique: async () => ({ defaultModelId: orgModel }) },
  },
}));

const { resolveReviewModel, resolveReviewRoute, MECHANICAL_MODEL } = await import("@/lib/review-routing");

const lockfile = "diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-old\n+new\n";
const source = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,12 @@\n"
  + Array.from({ length: 12 }, (_, i) => `+line ${i}`).join("\n") + "\n";
const tiny = "diff --git a/apps/web/lib/auth.ts b/apps/web/lib/auth.ts\n--- a/apps/web/lib/auth.ts\n+++ b/apps/web/lib/auth.ts\n@@ -1 +1 @@\n-old\n+new\n";
const resolve = (diff: string, modelOverride?: string, coverage?: ReviewCoverage) =>
  resolveReviewModel({ orgId: "org", repoId: "repo", diff, modelOverride, coverage });
const patch = "@@ -1 +1 @@\n-old\n+new\n";
const covered = (files: ReviewFileInput[], ignored?: string) => {
  const { diff, coverage } = prepareReviewInput(
    { provider: "github", headSha: "a", baseSha: "b", inventoryComplete: true, expectedFiles: files.length, limitations: [], files },
    { maxChars: 10_000, ignored: ignored ? parseOctopusIgnore(ignored) : undefined },
  );
  return { diff, coverage };
};
const resolveCovered = (...args: Parameters<typeof covered>) => {
  const { diff, coverage } = covered(...args);
  return resolve(diff, undefined, coverage);
};
const warn = console.warn;
console.warn = () => {};

delete process.env.OCTOPUS_MECHANICAL_MODEL;
assert.equal(await resolve(lockfile), ORG_PIN, "unconfigured: an org pin blocks the downshift");
orgModel = null;
assert.equal(await resolve(lockfile), MECHANICAL_MODEL, "unconfigured: an unpinned org downshifts to the built-in model");
orgModel = ORG_PIN;

process.env.OCTOPUS_MECHANICAL_MODEL = `  ${MECHANICAL}  `;
assert.equal(await resolve(lockfile), MECHANICAL, "configured: an org pin does not block the downshift");
assert.equal(await resolve(source), ORG_PIN, "configured: a substantive diff keeps the review model");
assert.equal(await resolve(tiny), ORG_PIN, "configured: a tiny non-mechanical diff does not override an org pin");
assert.equal(await resolve(lockfile, "acp:explicit"), "acp:explicit", "configured: an explicit override wins");
assert.equal(await resolveCovered([{ path: "bun.lock", change: "modified", patch }]), MECHANICAL, "configured: a lockfile-only change downshifts under an org pin");
assert.equal(
  await resolveCovered([{ path: "docs/b.md", previousPath: "docs/a.md", change: "renamed", patch }]),
  MECHANICAL, "configured: a docs to docs rename downshifts under an org pin",
);
assert.equal(
  await resolveCovered([{ path: "docs/auth.mdx", previousPath: "src/auth.ts", change: "renamed", patch }]),
  ORG_PIN, "configured: a source to docs rename keeps an org pin",
);
assert.equal(
  await resolveCovered([{ path: "src/__tests__/auth.test.ts", previousPath: "src/auth.ts", change: "renamed", patch }]),
  ORG_PIN, "configured: a source to test rename keeps an org pin",
);
assert.equal(
  await resolveCovered([
    { path: "README.md", change: "modified", patch },
    { path: "src/auth.ts", change: "modified", patch },
  ], "src/auth.ts"),
  ORG_PIN, "configured: docs plus a policy-excluded source file keeps an org pin",
);
assert.equal(
  await resolveCovered([
    { path: "README.md", change: "modified", patch },
    { path: "docs/copy.mdx", previousPath: "src/auth.ts", change: "copied", patch },
  ]),
  ORG_PIN, "configured: a source file copied into docs keeps an org pin",
);
orgModel = null;
assert.equal(await resolve(lockfile), MECHANICAL, "configured: an unpinned org downshifts to the configured model");
assert.equal(await resolve(tiny), MECHANICAL, "configured: an unpinned org downshifts a tiny diff");
orgModel = ORG_PIN;

repoModel = REPO_PIN;
assert.equal(await resolve(lockfile), REPO_PIN, "configured: a repo pin is respected");
repoModel = null;

const route = (diff: string, modelOverride?: string) => resolveReviewRoute({ orgId: "org", repoId: "repo", diff, modelOverride });
assert.deepEqual(await route(lockfile), { model: MECHANICAL, downshiftedFrom: ORG_PIN }, "a downshift reports the model it replaced");
assert.deepEqual(await route(source), { model: ORG_PIN, downshiftedFrom: null }, "no downshift reports none");
assert.deepEqual(await route(lockfile, "acp:explicit"), { model: "acp:explicit", downshiftedFrom: null }, "an explicit override reports none");
repoModel = REPO_PIN;
assert.deepEqual(await route(lockfile), { model: REPO_PIN, downshiftedFrom: null }, "a repo pin reports none");
repoModel = null;

process.env.OCTOPUS_MECHANICAL_MODEL = "acp:no-catalog-row";
assert.equal(await resolve(lockfile), ORG_PIN, "configured but unpriced: no downshift");

console.warn = warn;
console.log("PASS mechanical downshift follows OCTOPUS_MECHANICAL_MODEL");
