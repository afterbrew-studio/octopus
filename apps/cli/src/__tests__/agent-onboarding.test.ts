import { describe, expect, it } from "bun:test";
import { advanceAgentOnboarding, onboardingExitCode, type OnboardingContext, type OnboardingServices, type Connection } from "../lib/agent-onboarding.js";
import { detectOnboardingRepository, parseAgentOnboardingArgs } from "../commands/onboard-agent.js";

const context: OnboardingContext = { account: "work", repository: "acme/app", organization: { id: "org-1", name: "Acme" }, baseUrl: "https://octopus-review.ai" };
const ready = { id: "repo-1", fullName: "acme/app", provider: "github", indexStatus: "indexed", analysisStatus: "analyzed", indexedAt: "2026-09-10T10:00:00Z", analyzedAt: "2026-09-10T11:00:00Z", indexedFiles: 10, totalFiles: 12, analysis: "An API and a worker." };
function fixture(patch: Record<string, unknown> = {}, connection: Connection = { state: "connected", repoId: "repo-1" }) {
  const starts: string[] = [];
  const services: OnboardingServices = {
    connect: async () => ({ ok: true, data: connection }),
    status: async () => ({ ok: true, data: { repo: { ...ready, ...patch } } }),
    start: async (_id, operation) => { starts.push(operation); return { ok: true, data: {} }; },
  };
  return { starts, services };
}

describe("agent onboarding", () => {
  it("reuses completed work and includes the actual analysis", async () => {
    const { services, starts } = fixture();
    for (let n = 0; n < 2; n++) {
      const result = await advanceAgentOnboarding(context, services);
      expect(result.state).toBe("ready");
      expect(result.result?.analysis).toBe(ready.analysis);
      expect(onboardingExitCode(result)).toBe(0);
    }
    expect(starts).toEqual([]);
  });
  it("advances index then analysis across independent invocations", async () => {
    const f = fixture({ indexStatus: "pending", analysisStatus: "pending" });
    expect((await advanceAgentOnboarding(context, f.services)).state).toBe("indexing");
    expect(f.starts).toEqual(["index"]);
    const next = fixture({ analysisStatus: "pending" });
    expect((await advanceAgentOnboarding(context, next.services)).state).toBe("analyzing");
    expect(next.starts).toEqual(["analyze"]);
  });
  it("joins running work without another POST", async () => {
    for (const patch of [{ indexStatus: "indexing" }, { analysisStatus: "analyzing" }]) {
      const f = fixture(patch);
      const result = await advanceAgentOnboarding(context, f.services);
      expect(result.retryAfterSeconds).toBe(10);
      expect(onboardingExitCode(result)).toBe(3);
      expect(f.starts).toEqual([]);
    }
  });
  it("treats a concurrent start as waiting", async () => {
    const f = fixture({ analysisStatus: "pending" });
    f.services.start = async () => ({ ok: false, status: 409, error: "in progress" });
    expect((await advanceAgentOnboarding(context, f.services)).state).toBe("analyzing");
  });
  it("refreshes analysis older than its index", async () => {
    const f = fixture({ analyzedAt: "2026-09-09T00:00:00Z" });
    expect((await advanceAgentOnboarding(context, f.services)).state).toBe("analyzing");
    expect(f.starts).toEqual(["analyze"]);
  });
  it("does not restart failed jobs or claim incomplete evidence is ready", async () => {
    for (const patch of [{ indexStatus: "failed" }, { analysisStatus: "failed" }, { analysis: "" }, { indexedAt: null }, { analysisStatus: "mystery" }, { indexedAt: "invalid" }, { indexedFiles: 0, totalFiles: 0 }, { indexedFiles: 20, totalFiles: 10 }]) {
      const f = fixture(patch);
      expect((await advanceAgentOnboarding(context, f.services)).state).toBe("failed");
      expect(f.starts).toEqual([]);
    }
  });
  it("rejects the wrong repository even when status says completed", async () => {
    for (const patch of [{ id: "repo-2" }, { fullName: "other/app" }, { provider: "gitlab" }]) {
      expect((await advanceAgentOnboarding(context, fixture(patch).services)).state).toBe("failed");
    }
  });
  it("returns scoped installation or access links without starting work", async () => {
    for (const connection of [
      { state: "installation_required", url: "https://octopus-review.ai/api/github/install?orgId=org-1" },
      { state: "repository_access_required", url: "https://github.com/organizations/acme/settings/installations/42" },
    ] as Connection[]) {
      const f = fixture({}, connection);
      const result = await advanceAgentOnboarding(context, f.services);
      expect(result.state).toBe("connection_required");
      expect(result.nextAction?.kind).toBe("open_url");
      expect(result.continueWith).toContain("work");
      expect(f.starts).toEqual([]);
    }
  });
  it("keeps a dismissed repo as an explicit human decision", async () => {
    const f = fixture({}, { state: "repository_dismissed", url: "https://octopus-review.ai/repositories" });
    expect((await advanceAgentOnboarding(context, f.services)).state).toBe("repository_dismissed");
    expect(f.starts).toEqual([]);
  });
  it("rejects arbitrary approval links", async () => {
    for (const url of ["https://evil.test/setup", "javascript:alert(1)", "https://github.com/acme/app", "https://u:p@github.com/settings/installations/1"]) {
      const f = fixture({}, { state: "repository_access_required", url });
      expect((await advanceAgentOnboarding(context, f.services)).state).toBe("failed");
    }
  });
  it("gives a login handoff for expired auth and does not echo server errors", async () => {
    const f = fixture();
    f.services.connect = async () => ({ ok: false, status: 401, error: "oct_secret_token" });
    const result = await advanceAgentOnboarding(context, f.services);
    expect(result.state).toBe("authentication_required");
    expect(result.nextAction?.argv).toContain("--no-open");
    expect(JSON.stringify(result)).not.toContain("oct_secret_token");
    for (const status of [0, 403, 404, 503]) {
      f.services.connect = async () => ({ ok: false, status, error: "oct_secret_token" });
      const failed = await advanceAgentOnboarding(context, f.services);
      expect(failed.state).toBe("failed");
      expect(JSON.stringify(failed)).not.toContain("oct_secret_token");
    }
  });
});

describe("agent onboarding input", () => {
  it("rejects typos, duplicate flags, extra arguments and ambiguous names", () => {
    for (const args of [["--agnt"], ["--json", "--json"], ["extra"], ["--repo"], ["--repo", "app"], ["--repo", "acme/.."], ["--reset"]]) {
      expect(() => parseAgentOnboardingArgs(args)).toThrow();
    }
    expect(parseAgentOnboardingArgs(["--agent", "--json", "--repo", "acme/app"])).toEqual({ repo: "acme/app" });
  });
  it("detects HTTPS and SSH GitHub remotes without exposing embedded credentials", () => {
    for (const url of ["git@github.com:acme/app.git", "https://github.com/acme/app.git", "ssh://git@github.com/acme/app.git"]) {
      expect(detectOnboardingRepository((args) => args.length === 1 ? "origin" : url)).toBe("acme/app");
    }
    for (const url of ["https://secret@github.com/acme/app.git", "https://gitlab.com/acme/app.git"]) {
      expect(() => detectOnboardingRepository((args) => args.length === 1 ? "origin" : url)).toThrow("github.com remotes");
    }
    expect(() => detectOnboardingRepository(() => "upstream\nbackup")).toThrow("unambiguous");
  });
});
