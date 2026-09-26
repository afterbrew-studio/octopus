import assert from "node:assert/strict";
import { mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseIntegrationSetupStatus } from "@/lib/integration-setup";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
mock.module("@/app/(app)/settings/integrations/actions", () => ({
  retryIntegrationSetup() {}, getIntegrationWebhookDetails() {}, disconnectBitbucket() {}, disconnectGitlab() {}, startGitlabOAuth() {},
}));
const { IntegrationSetupPanel } = await import("@/app/(app)/settings/integrations/integration-setup-panel");
const { BitbucketIntegrationCard } = await import("@/app/(app)/settings/integrations/bitbucket-integration-card");
const { GitlabIntegrationCard } = await import("@/app/(app)/settings/integrations/gitlab-integration-card");
const render = (provider: "github" | "bitbucket" | "gitlab" | "forgejo", value: unknown, canManage = true) =>
  renderToStaticMarkup(<IntegrationSetupPanel provider={provider} setupStatus={parseIntegrationSetupStatus(value)} canManage={canManage} />);

const { IntegrationOAuthErrorBanner } = await import("@/app/(app)/settings/integrations/integration-oauth-error-banner");
const replacement = renderToStaticMarkup(<IntegrationOAuthErrorBanner error="connection_replacement" />);
assert.ok(replacement.includes('role="alert"'));
assert.ok(replacement.includes("disconnect the current provider"));
assert.ok(replacement.includes("owner or admin"));

const legacy = render("bitbucket", null);
assert.equal((legacy.match(/Not checked/g) ?? []).length, 2);
assert.ok(legacy.includes("Retry setup"));
assert.ok(!legacy.includes(">Synced<"));
assert.ok(legacy.includes("Repair an existing webhook"));
assert.ok(legacy.includes("Show webhook details"));
assert.ok(!legacy.includes("Existing webhook secret"));
assert.ok(legacy.includes("prepares the repository automatically"));
assert.ok(!legacy.includes("create its index"));
const failed = render("gitlab", {
  sync: { status: "ready" },
  webhook: { status: "failed", error: "Webhook setup needs Maintainer access for 2 projects." },
});
assert.ok(failed.includes(">Synced<"));
assert.ok(failed.includes("Needs attention"));
assert.ok(failed.includes("Maintainer access for 2 projects"));
assert.ok(failed.includes("Retry setup"));
const ready = render("bitbucket", { sync: { status: "ready" }, webhook: { status: "ready" } });
assert.ok(ready.includes(">Configured<"));
assert.ok(ready.includes("Check setup"));
assert.ok(ready.includes("confirm delivery"));
assert.ok(!ready.includes("delivery verified"));
const member = render("gitlab", null, false);
assert.ok(!member.includes(">Retry setup<"));
assert.ok(member.includes('href="/repositories"'));
assert.ok(member.includes("owner or admin"));
assert.ok(!member.includes("Show webhook details"));
assert.ok(!member.includes("Repair an existing webhook"));
const github = render("github", null);
assert.ok(github.includes("Managed by GitHub App"));
assert.ok(github.includes("does not confirm"));
const forgejo = render("forgejo", { sync: { status: "ready" }, webhook: { status: "manual" } });
assert.ok(forgejo.includes("Manual setup required"));
assert.ok(forgejo.includes("does not create webhooks"));
assert.ok(forgejo.includes('href="/docs/integrations#forgejo"'));

for (const connected of [false, true]) {
  const bb = renderToStaticMarkup(<BitbucketIntegrationCard canManage={false} data={connected ? { workspaceName: "Team", workspaceSlug: "team" } : null} />);
  const gl = renderToStaticMarkup(<GitlabIntegrationCard canManage={false} redirectUri={null} data={connected ? { namespaceName: "Team", namespacePath: "team", gitlabHost: "https://gitlab.com" } : null} />);
  assert.ok(bb.includes('id="bitbucket"'));
  assert.ok(gl.includes('id="gitlab"'));
  if (connected) {
    for (const html of [bb, gl]) {
      assert.ok(html.includes("Access authorized"));
      assert.ok(html.includes("Not checked"));
      assert.ok(!html.includes("Disconnect Bitbucket") && !html.includes("Disconnect GitLab"));
    }
  } else {
    assert.ok(bb.includes("<fieldset disabled="));
    assert.ok(gl.includes("<fieldset disabled="));
  }
}
