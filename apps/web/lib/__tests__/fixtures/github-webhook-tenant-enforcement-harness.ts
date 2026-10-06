import crypto from "node:crypto";
import { mock } from "bun:test";

const WEBHOOK_SECRET = "github-webhook-enforcement-test-secret";

type AfterCallback = () => void | Promise<void>;
type DeliveryUpsertArgs = {
  where: {
    provider_deliveryId: { provider: string; deliveryId: string };
  };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
};

const afterCallbacks: AfterCallback[] = [];
const deliveryWrites: DeliveryUpsertArgs[] = [];
const reviewCalls: Array<Record<string, unknown>> = [];
const mutationCalls: Array<{ kind: string; args: Record<string, unknown> }> = [];
let failNextLedgerWrite = false;
let installationBindingCleared = false;
let legacyRepositoryLookups = 0;
let autoDiscoverEnabled = true;
let createdRepository = false;
let repositoryDismissed = false;
const syncCalls: Array<{ organizationId: string; source: string }> = [];

const webhookDeliveryStore = {
  upsert: (args: DeliveryUpsertArgs) => {
    if (failNextLedgerWrite) {
      failNextLedgerWrite = false;
      return Promise.reject(new Error("ledger unavailable"));
    }
    deliveryWrites.push(args);
    return Promise.resolve({
      attemptCount: 1,
      payloadSha256: String(args.create.payloadSha256),
    });
  },
  update: () => Promise.resolve({ payloadHashCollisionCount: 1 }),
};

mock.module("server-only", () => ({}));
mock.module("next/server", () => ({
  after: (callback: AfterCallback) => afterCallbacks.push(callback),
  NextRequest: Request,
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
  },
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("@/lib/github-app-config", () => ({
  getGithubAppConfig: () =>
    Promise.resolve({ webhookSecret: WEBHOOK_SECRET, appId: "123", slug: "octopus" }),
}));
// `null` is "no octopus.json", which every case except the labeled one wants.
let configuredReviewLabels: string | null = null;

mock.module("@/lib/github", () => ({
  listInstallationRepos: () => Promise.resolve([]),
  getRepositoryDetails: () => Promise.resolve(null),
  addCommentReaction: () => Promise.resolve(),
  getPullRequestDetails: () => Promise.resolve(null),
  createCheckRun: () => Promise.resolve(1),
  updateCheckRun: () => Promise.resolve(),
  // The label trigger reads the repository's `octopus.json` through this. Null is "no
  // config file", which is the state every repository in this harness is in.
  getFileContent: () => Promise.resolve(configuredReviewLabels),
  isOwnCheckRun: (name: string | undefined) => typeof name === "string" && name.trim().toLowerCase().startsWith("octopus review"),
}));
// Bringing a held review's recheck forward is its own unit; here only who it is asked for.
const rechecks: Array<{ repositoryId: string; headSha: string }> = [];
mock.module("@/lib/review-hold", () => ({
  recheckHeldReviews: (repositoryId: string, headSha: string) => {
    rechecks.push({ repositoryId, headSha });
    return Promise.resolve(1);
  },
}));
mock.module("@/lib/repo-sync", () => ({
  syncOrgRepos: (organizationId: string, opts: { source: string }) => {
    syncCalls.push({ organizationId, source: opts.source });
    return Promise.resolve({ synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] });
  },
  applyRepositoryEvent: (organizationId: string, installationId: number, action: string) => {
    syncCalls.push({ organizationId, source: `repository.${action}@${installationId}` });
    if (!repositoryDismissed) createdRepository = true;
    return Promise.resolve("created");
  },
}));
mock.module("@/lib/webhook-shared", () => ({
  startReviewFlow: (input: Record<string, unknown>) => {
    reviewCalls.push(input);
    return Promise.resolve();
  },
}));
mock.module("@octopus/db", () => ({
  prisma: {
    organization: {
      findFirst: (args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id === "org_b" && !installationBindingCleared
            ? { id: "org_b", autoDiscoverRepos: autoDiscoverEnabled }
            : null,
        ),
      findUnique: (args: {
        where: { githubInstallationId?: number; id?: string };
      }) => {
        if (args.where.githubInstallationId === 222) {
          if (installationBindingCleared) return Promise.resolve(null);
          return Promise.resolve({ id: "org_b" });
        }
        if (args.where.id === "org_b") {
          return Promise.resolve({ blockedAuthors: [], autoDiscoverRepos: autoDiscoverEnabled });
        }
        return Promise.resolve(null);
      },
      updateMany: () => {
        installationBindingCleared = true;
        return Promise.resolve({ count: 1 });
      },
    },
    repository: {
      findFirst: () => {
        legacyRepositoryLookups += 1;
        return Promise.resolve({
          id: "repo_a",
          organizationId: "org_a",
          autoReview: true,
          installationId: 222,
        });
      },
      findUnique: (args: {
        where: {
          id?: string;
          provider_externalId_organizationId?: {
            provider: string;
            externalId: string;
            organizationId: string;
          };
        };
      }) => {
        if (args.where.provider_externalId_organizationId) {
          // Only the shared repository (9001) has a row; 9002 is brand new.
          if (args.where.provider_externalId_organizationId.externalId !== "9001" && !createdRepository) {
            return Promise.resolve(null);
          }
          return Promise.resolve({ id: "repo_b", organizationId: "org_b" });
        }
        if (args.where.id === "repo_b") {
          return Promise.resolve({
            id: "repo_b",
            organizationId: "org_b",
            autoReview: true,
            installationId: 222,
            fullName: "shared/repository",
            defaultBranch: "main",
            indexStatus: "pending",
            isActive: true,
            dismissedAt: repositoryDismissed ? new Date() : null,
          });
        }
        return Promise.resolve(null);
      },
      findMany: () => Promise.resolve([]),
      count: () => Promise.resolve(2),
      update: (args: Record<string, unknown>) => {
        mutationCalls.push({ kind: "repository.update", args });
        return Promise.resolve({});
      },
      upsert: () => Promise.resolve({}),
    },
    pullRequest: {
      updateMany: (args: Record<string, unknown>) => {
        mutationCalls.push({ kind: "pullRequest.updateMany", args });
        return Promise.resolve({ count: 1 });
      },
    },
    systemConfig: {
      findUnique: () => Promise.resolve({ blockedAuthors: [] }),
    },
    webhookDelivery: webhookDeliveryStore,
    $transaction: <T>(
      callback: (transaction: {
        webhookDelivery: typeof webhookDeliveryStore;
      }) => Promise<T>,
    ) => callback({ webhookDelivery: webhookDeliveryStore }),
  },
}));

const { POST } = await import("@/app/api/github/webhook/route");

function pullRequestBody() {
  return JSON.stringify({
    action: "opened",
    installation: { id: 222 },
    repository: { id: 9001, full_name: "shared/repository" },
    pull_request: {
      number: 17,
      title: "Tenant collision regression",
      html_url: "https://github.test/shared/repository/pull/17",
      user: { login: "contributor" },
      head: { sha: "abc123" },
      draft: false,
    },
  });
}

function mergedPullRequestBody() {
  return JSON.stringify({
    action: "closed",
    installation: { id: 222 },
    repository: { id: 9001, full_name: "shared/repository" },
    pull_request: {
      number: 18,
      merged: true,
    },
  });
}

function issueCommentBody() {
  return JSON.stringify({
    action: "created",
    installation: { id: 222 },
    repository: { id: 9001, full_name: "shared/repository" },
    issue: {
      number: 19,
      title: "Mention review",
      html_url: "https://github.test/shared/repository/pull/19",
      user: { login: "contributor" },
      pull_request: {},
    },
    comment: {
      id: 88,
      body: "@octopus review this",
      user: { type: "User", login: "contributor" },
    },
  });
}

function labeledPullRequestBody() {
  return JSON.stringify({
    action: "labeled",
    installation: { id: 222 },
    repository: { id: 9001, full_name: "shared/repository", default_branch: "main" },
    label: { name: "review:octopus" },
    pull_request: {
      number: 20,
      title: "Label-triggered review",
      html_url: "https://github.test/shared/repository/pull/20",
      user: { login: "contributor" },
      head: { sha: "def456" },
      draft: false,
    },
  });
}

function webhookRequest(
  body: string,
  options: {
    deliveryId?: string;
    eventType?: string;
    validSignature?: boolean;
  } = {},
) {
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return new Request("https://app.test/api/github/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": options.eventType ?? "pull_request",
      "x-github-delivery": options.deliveryId ?? "delivery-123",
      "x-hub-signature-256": options.validSignature === false
        ? "sha256=invalid"
        : `sha256=${signature}`,
    },
    body,
  }) as never;
}

async function runAfterCallbacks() {
  const callbacks = afterCallbacks.splice(0);
  await Promise.all(callbacks.map((callback) => callback()));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
};
console.log = () => undefined;
console.info = () => undefined;
console.warn = () => undefined;

try {
  const invalidResponse = await POST(
    webhookRequest(pullRequestBody(), { validSignature: false }),
  );
  assert(invalidResponse.status === 401, "invalid signature was not rejected");
  assert(afterCallbacks.length === 0, "invalid signature scheduled observation");
  assert(deliveryWrites.length === 0, "invalid signature wrote to the ledger");
  assert(reviewCalls.length === 0, "invalid signature started a review");

  const collisionResponse = await POST(webhookRequest(pullRequestBody()));
  assert(collisionResponse.status === 200, "valid collision response failed");
  assert(reviewCalls[0]?.orgId === "org_b", "signed installation did not select tenant");
  assert(reviewCalls[0]?.repoId === "repo_b", "compound tenant/repository lookup was not enforced");
  await runAfterCallbacks();
  const collision = deliveryWrites.at(-1)?.create;
  assert(collision?.resolvedOrganizationId === "org_b", "trusted tenant was not recorded");
  assert(
    collision?.legacyOrganizationId === null,
    "legacy repository unexpectedly remained routing input",
  );
  assert(
    collision?.comparisonStatus === "not_applicable",
    "post-enforcement telemetry unexpectedly compared legacy routing",
  );

  const reviewsBeforeUnmapped = reviewCalls.length;
  const unmappedBody = JSON.stringify({
    ...JSON.parse(pullRequestBody()),
    installation: { id: 999 },
  });
  const unmappedResponse = await POST(
    webhookRequest(unmappedBody, { deliveryId: "delivery-unmapped" }),
  );
  await runAfterCallbacks();
  assert(unmappedResponse.status === 200, "unmapped installation response failed");
  assert(
    reviewCalls.length === reviewsBeforeUnmapped,
    "unmapped installation was not dropped",
  );

  const mergedResponse = await POST(
    webhookRequest(mergedPullRequestBody(), {
      deliveryId: "delivery-merged",
    }),
  );
  await runAfterCallbacks();
  assert(mergedResponse.status === 200, "merged PR response failed");
  assert(
    mutationCalls.some(
      (call) =>
        call.kind === "pullRequest.updateMany" &&
        (call.args.where as { repositoryId?: string })?.repositoryId === "repo_b",
    ),
    "merged PR did not mutate only the installation-owned repository",
  );

  const reviewsBeforeMention = reviewCalls.length;
  const mentionResponse = await POST(
    webhookRequest(issueCommentBody(), {
      deliveryId: "delivery-mention",
      eventType: "issue_comment",
    }),
  );
  await runAfterCallbacks();
  assert(mentionResponse.status === 200, "issue comment response failed");
  assert(
    reviewCalls.length === reviewsBeforeMention + 1 &&
      reviewCalls.at(-1)?.orgId === "org_b" &&
      reviewCalls.at(-1)?.repoId === "repo_b",
    "issue comment did not route through the installation-owned repository",
  );
  assert(legacyRepositoryLookups === 0, "legacy repository-only lookup was used");

  // The label trigger is a third path into startReviewFlow, and it resolves the tenant the
  // same way the two above it do. Asserted here rather than assumed: this harness exists to
  // prove cross-tenant routing, and a path it does not exercise is a path it says nothing
  // about.
  configuredReviewLabels = JSON.stringify({ labels: ["review:octopus"] });
  const reviewsBeforeLabel = reviewCalls.length;
  const labelResponse = await POST(
    webhookRequest(labeledPullRequestBody(), {
      deliveryId: "delivery-labeled",
      eventType: "pull_request",
    }),
  );
  await runAfterCallbacks();
  assert(labelResponse.status === 200, "labeled response failed");
  assert(
    reviewCalls.length === reviewsBeforeLabel + 1 &&
      reviewCalls.at(-1)?.orgId === "org_b" &&
      reviewCalls.at(-1)?.repoId === "repo_b",
    "labeled PR did not route through the installation-owned repository",
  );

  // A label the config does not name must start nothing.
  configuredReviewLabels = JSON.stringify({ labels: ["some-other-label"] });
  const reviewsBeforeUnmatched = reviewCalls.length;
  const unmatchedResponse = await POST(
    webhookRequest(labeledPullRequestBody(), {
      deliveryId: "delivery-labeled-unmatched",
      eventType: "pull_request",
    }),
  );
  await runAfterCallbacks();
  assert(unmatchedResponse.status === 200, "unmatched label response failed");
  assert(
    reviewCalls.length === reviewsBeforeUnmatched,
    "a label the config does not name started a review",
  );
  configuredReviewLabels = null;

  // A check finishing brings forward the recheck of a review held for that commit, for the
  // signed installation's own repository only.
  const sha = "c".repeat(40);
  const checkBody = (event: "check_run" | "check_suite", action: string, extra: Record<string, unknown> = {}, installation = 222) =>
    JSON.stringify({
      action, installation: { id: installation }, repository: { id: 9001, full_name: "shared/repository" },
      [event]: { head_sha: sha, ...extra },
    });
  const send = (body: string, eventType: string, deliveryId: string, validSignature = true) =>
    POST(webhookRequest(body, { eventType, deliveryId, validSignature }));
  const suiteResponse = await send(checkBody("check_suite", "completed", { conclusion: "success" }), "check_suite", "delivery-suite");
  const runResponse = await send(checkBody("check_run", "completed", { name: "swift build + tests (macos)" }), "check_run", "delivery-run");
  assert(suiteResponse.status === 200 && runResponse.status === 200, "check event response failed");
  assert(
    rechecks.length === 2 && rechecks.every((call) => call.repositoryId === "repo_b" && call.headSha === sha),
    "completed check events did not ask for the signed repository's held reviews to be rechecked",
  );
  const before = rechecks.length;
  await send(checkBody("check_run", "completed", { name: "Octopus Review" }), "check_run", "delivery-own");
  await send(checkBody("check_run", "created", { name: "build" }), "check_run", "delivery-created");
  await send(checkBody("check_suite", "requested"), "check_suite", "delivery-requested");
  await send(checkBody("check_suite", "completed", {}, 999), "check_suite", "delivery-unmapped-check");
  const forged = await send(checkBody("check_suite", "completed"), "check_suite", "delivery-forged", false);
  assert(forged.status === 401, "a check event with a bad signature was accepted");
  assert(rechecks.length === before, "an own, unfinished, unmapped or unsigned check event brought a recheck forward");

  failNextLedgerWrite = true;
  const failureResponse = await POST(
    webhookRequest(pullRequestBody(), { deliveryId: "delivery-db-failure" }),
  );
  await runAfterCallbacks();
  assert(failureResponse.status === 200, "ledger failure changed webhook response");

  const uninstallBody = JSON.stringify({
    action: "deleted",
    installation: { id: 222 },
  });
  const uninstallResponse = await POST(
    webhookRequest(uninstallBody, {
      deliveryId: "delivery-uninstall",
      eventType: "installation",
    }),
  );
  await runAfterCallbacks();
  const uninstall = deliveryWrites.at(-1)?.create;
  assert(uninstallResponse.status === 200, "uninstall response failed");
  assert(
    uninstall?.resolvedOrganizationId === "org_b" &&
      uninstall?.resolutionStatus === "installation_only",
    "uninstall lost its pre-mutation tenant snapshot",
  );
  assert(installationBindingCleared, "uninstall did not clear the installation binding");
  assert(syncCalls.length === 0, "uninstall or earlier events unexpectedly triggered a repo sync");

  // A first PR recovers a missed creation event before routing the review.
  installationBindingCleared = false;
  const firstPrBody = JSON.stringify({
    ...JSON.parse(pullRequestBody()),
    repository: { id: 9002, name: "brand-new", full_name: "shared/brand-new", default_branch: "main" },
  });
  const reviewsBeforeRecovery = reviewCalls.length;
  autoDiscoverEnabled = false;
  await POST(webhookRequest(firstPrBody));
  await runAfterCallbacks();
  assert(reviewCalls.length === reviewsBeforeRecovery && syncCalls.length === 0, "PR discovery ignored opt-out");
  autoDiscoverEnabled = true;
  repositoryDismissed = true;
  await POST(webhookRequest(pullRequestBody()));
  await POST(webhookRequest(issueCommentBody(), { eventType: "issue_comment" }));
  await runAfterCallbacks();
  assert(reviewCalls.length === reviewsBeforeRecovery, "a previously discovered, dismissed repository was reviewed");
  await POST(webhookRequest(firstPrBody));
  await runAfterCallbacks();
  assert(reviewCalls.length === reviewsBeforeRecovery, "a dismissed repository was reviewed");
  repositoryDismissed = false;
  await POST(webhookRequest(firstPrBody));
  await runAfterCallbacks();
  assert(reviewCalls.length === reviewsBeforeRecovery + 1, "first PR was dropped after discovery");
  assert(reviewCalls.at(-1)?.orgId === "org_b", "first PR crossed the installation boundary");
  createdRepository = false;
  syncCalls.length = 0;

  // Re-bind the installation for the repository lifecycle scenarios.
  installationBindingCleared = false;
  const repositoryCreatedBody = JSON.stringify({
    action: "created",
    installation: { id: 222 },
    repository: { id: 9002, full_name: "shared/brand-new" },
  });
  const createdResponse = await POST(
    webhookRequest(repositoryCreatedBody, {
      deliveryId: "delivery-repo-created",
      eventType: "repository",
    }),
  );
  await runAfterCallbacks();
  assert(createdResponse.status === 200, "repository.created response failed");
  assert(
    syncCalls.length === 1 &&
      syncCalls[0].organizationId === "org_b" &&
      syncCalls[0].source === "repository.created@222",
    "repository.created did not write the mapped organization's repository",
  );

  const unmappedCreatedBody = JSON.stringify({
    action: "created",
    installation: { id: 999 },
    repository: { id: 9003, full_name: "stranger/brand-new" },
  });
  const unmappedCreatedResponse = await POST(
    webhookRequest(unmappedCreatedBody, {
      deliveryId: "delivery-repo-created-unmapped",
      eventType: "repository",
    }),
  );
  await runAfterCallbacks();
  assert(unmappedCreatedResponse.status === 200, "unmapped repository.created response failed");
  assert(syncCalls.length === 1, "unmapped repository.created was not dropped");

  autoDiscoverEnabled = false;
  const optOutResponse = await POST(
    webhookRequest(repositoryCreatedBody, {
      deliveryId: "delivery-repo-created-opt-out",
      eventType: "repository",
    }),
  );
  await runAfterCallbacks();
  autoDiscoverEnabled = true;
  assert(optOutResponse.status === 200, "opt-out repository.created response failed");
  assert(syncCalls.length === 1, "repository.created ignored the organization opt-out");

  const addedBody = JSON.stringify({
    action: "added",
    installation: { id: 222 },
    repositories_added: [{ id: 9004, name: "added", full_name: "shared/added" }],
    repositories_removed: [],
  });
  const addedResponse = await POST(
    webhookRequest(addedBody, {
      deliveryId: "delivery-repos-added",
      eventType: "installation_repositories",
    }),
  );
  await runAfterCallbacks();
  assert(addedResponse.status === 200, "installation_repositories response failed");
  assert(
    syncCalls.length === 2 &&
      syncCalls[1].organizationId === "org_b" &&
      syncCalls[1].source === "webhook",
    "installation_repositories did not run the shared sync for the mapped organization",
  );

  originalConsole.log(JSON.stringify({
    invalidSignatureRejected: true,
    trustedRoutingEnforced: true,
    unmappedInstallationDropped: true,
    mergedAndMentionScoped: true,
    labelTriggerScoped: true,
    heldReviewRecheckScoped: true,
    ledgerFailureNonFatal: true,
    uninstallTenantCaptured: true,
    repositoryCreatedSynced: true,
    repositoryCreatedUnmappedDropped: true,
    repositoryCreatedRespectsOptOut: true,
    installationRepositoriesSynced: true,
    firstPrRecoversMissingRepository: true,
  }));
} catch (error) {
  originalConsole.warn(error);
  process.exitCode = 1;
} finally {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
}
