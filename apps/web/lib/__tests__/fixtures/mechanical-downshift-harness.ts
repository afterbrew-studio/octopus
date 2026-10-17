import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * OCTOPUS_MECHANICAL_MODEL downshifts diffs made up entirely of mechanical files even under an org
 * pin, never under a repo pin, and an unconfigured deployment keeps the built-in behaviour.
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

const { resolveReviewModel, MECHANICAL_MODEL } = await import("@/lib/review-routing");

const lockfile = "diff --git a/bun.lock b/bun.lock\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n-old\n+new\n";
const source = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,12 @@\n"
  + Array.from({ length: 12 }, (_, i) => `+line ${i}`).join("\n") + "\n";
const tiny = "diff --git a/apps/web/lib/auth.ts b/apps/web/lib/auth.ts\n--- a/apps/web/lib/auth.ts\n+++ b/apps/web/lib/auth.ts\n@@ -1 +1 @@\n-old\n+new\n";
const resolve = (diff: string, modelOverride?: string) =>
  resolveReviewModel({ orgId: "org", repoId: "repo", diff, modelOverride });
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
orgModel = null;
assert.equal(await resolve(lockfile), MECHANICAL, "configured: an unpinned org downshifts to the configured model");
assert.equal(await resolve(tiny), MECHANICAL, "configured: an unpinned org downshifts a tiny diff");
orgModel = ORG_PIN;

repoModel = REPO_PIN;
assert.equal(await resolve(lockfile), REPO_PIN, "configured: a repo pin is respected");
repoModel = null;

process.env.OCTOPUS_MECHANICAL_MODEL = "acp:no-catalog-row";
assert.equal(await resolve(lockfile), ORG_PIN, "configured but unpriced: no downshift");

console.warn = warn;
console.log("PASS mechanical downshift follows OCTOPUS_MECHANICAL_MODEL");
