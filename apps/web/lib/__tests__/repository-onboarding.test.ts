import { expect, it } from "bun:test";
import { getOnboardingRepositoryUrl, getPreparationProgress, getRepositoryReadiness } from "../repository-onboarding";

it("separates repository access, webhook configuration and automatic preparation", () => {
  const setupStatus = { sync: { status: "ready" }, webhook: { status: "ready" } };
  const input = { provider: "github", connected: true, setupStatus };
  expect(getRepositoryReadiness(input).status).toBe("ready");
  expect(getRepositoryReadiness({ ...input, installationMatches: false }).status).toBe("needs_action");
  expect(getRepositoryReadiness({ ...input, setupStatus: null }).status).toBe("unconfirmed");
  expect(getRepositoryReadiness({ ...input, provider: "forgejo" }).status).toBe("unconfirmed");
  expect(getRepositoryReadiness({ ...input, provider: "forgejo", connectorUnavailable: true }).status).toBe("needs_action");
  const failedHook = { sync: { status: "ready" }, webhook: { status: "failed", error: "Repair the webhook" } };
  expect(getRepositoryReadiness({ ...input, provider: "bitbucket", setupStatus: failedHook })).toEqual({ status: "needs_action", message: "Repair the webhook" });
  // Another GitLab project's hook failure must not block this project's guide.
  expect(getRepositoryReadiness({ ...input, provider: "gitlab", setupStatus: failedHook, webhookSetupStatus: { status: "ready" } }).status).toBe("ready");
  expect(getRepositoryReadiness({ ...input, provider: "gitlab" }).status).toBe("unconfirmed");
  expect(getPreparationProgress("pending", "none").status).toBe("waiting");
  expect(getPreparationProgress("indexing", "none").status).toBe("working");
  expect(getPreparationProgress("failed", "analyzed").status).toBe("failed");
  expect(getPreparationProgress("indexed", "failed").status).toBe("failed");
  expect(getPreparationProgress("indexed", "analyzed").status).toBe("ready");
  expect(getOnboardingRepositoryUrl("gitlab", "group/sub/repo", "https://git.example:8443")).toBe("https://git.example:8443/group/sub/repo");
  expect(getOnboardingRepositoryUrl("forgejo", "team/project", "https://forge.internal")).toBe("https://forge.internal/team/project");
  expect(getOnboardingRepositoryUrl("forgejo", "team/project", "javascript:alert(1)")).toBeNull();
  expect(getOnboardingRepositoryUrl("forgejo", "team/project", "https://secret@forge.internal")).toBeNull();
});

it("renders the actual dashboard journey with scoped review evidence", async () => {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/onboarding-dashboard-harness.tsx", import.meta.url).pathname], {
    cwd: new URL("../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, `${stdout}\n${stderr}`).toBe(0);
});
