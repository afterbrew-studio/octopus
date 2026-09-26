import type { ApiResult } from "./api.js";

export type OnboardingState =
  | "organization_required" | "authentication_required" | "connection_required" | "repository_dismissed"
  | "indexing" | "analyzing" | "ready" | "failed" | "invalid_input";

export interface AgentOnboardingResult {
  schemaVersion: 1;
  state: OnboardingState;
  account: string;
  repository: string;
  organization?: { id: string; name: string };
  organizations?: Array<{ id: string; slug: string; name: string }>;
  message: string;
  completed: string[];
  nextAction?: { kind: "run_command" | "open_url" | "retry"; argv?: string[]; url?: string };
  continueWith: string[];
  retryAfterSeconds?: number;
  result?: { indexedFiles: number; totalFiles: number; indexedAt: string; analyzedAt: string; analysis: string };
}

export type Connection =
  | { state: "connected"; repoId: string }
  | { state: "installation_required" | "repository_access_required" | "repository_dismissed"; url: string };

export interface OnboardingServices {
  connect: () => Promise<ApiResult<Connection>>;
  status: (id: string) => Promise<ApiResult<unknown>>;
  start: (id: string, operation: "index" | "analyze") => Promise<ApiResult<unknown>>;
}

export interface OnboardingContext {
  org?: string;
  account: string;
  repository: string;
  organization?: { id: string; name: string };
  baseUrl: string;
}

export function onboardingResult(context: OnboardingContext, state: OnboardingState, message: string): AgentOnboardingResult {
  return {
    schemaVersion: 1, state, account: context.account, repository: context.repository,
    ...(context.organization ? { organization: context.organization } : {}),
    message, completed: [],
    continueWith: ["octp", "--account", context.account, ...(context.org ? ["--org", context.org] : []), "onboard", "--agent", "--json", "--repo", context.repository],
  };
}

export function onboardingExitCode(result: AgentOnboardingResult): number {
  if (result.state === "ready") return 0;
  if (result.state === "invalid_input") return 2;
  if (result.state === "failed") return 1;
  return 3;
}

function approvedUrl(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    const server = new URL(baseUrl);
    if (u.origin === server.origin && ["/api/github/install", "/repositories"].includes(u.pathname)) return u.href;
    if (u.origin === "https://github.com" && /^\/(?:settings\/installations\/\d+|organizations\/[A-Za-z0-9-]+\/settings\/installations\/\d+)$/.test(u.pathname)) return u.href;
  } catch { /* Invalid response URL is not an approval action. */ }
  return null;
}

/** Advances at most one background operation. Server status is the checkpoint. */
export async function advanceAgentOnboarding(context: OnboardingContext, services: OnboardingServices): Promise<AgentOnboardingResult> {
  const fail = (message: string) => onboardingResult(context, "failed", message);
  const apiFailure = (status: number, step: string): AgentOnboardingResult => {
    if (status === 401) {
      const result = onboardingResult(context, "authentication_required", "Sign in, complete the approval link printed by login, then resume setup.");
      result.nextAction = { kind: "run_command", argv: ["octp", "--account", context.account, "login", "--no-open", "--api-url", context.baseUrl] };
      return result;
    }
    return fail(status === 404 && step === "connect"
      ? "This server does not support agent onboarding. Update the server or use the CLI setup guide."
      : `Could not ${step} (HTTP ${status}). Check account access or server availability, then resume. No completion is assumed.`);
  };

  const connection = await services.connect();
  if (!connection.ok) return apiFailure(connection.status, "connect");
  const data = connection.data;
  if (!data || typeof data !== "object") return fail("Invalid connection response from the server.");
  if (data.state !== "connected") {
    if (!["installation_required", "repository_access_required", "repository_dismissed"].includes(data.state)) return fail("Unknown connection state from the server.");
    const url = approvedUrl(data.url, context.baseUrl);
    if (!url) return fail("The server returned an invalid approval link.");
    const dismissed = data.state === "repository_dismissed";
    const result = onboardingResult(context, dismissed ? "repository_dismissed" : "connection_required",
      dismissed ? "This repository was deliberately removed. Decide whether to restore it before continuing."
        : data.state === "installation_required" ? "Open this link to install or approve the Octopus GitHub App for this organisation. Select the target repository. If an owner must approve it, resume after they do."
        : "Open this link and grant the existing GitHub App installation access to the target repository, then resume.");
    result.completed = ["authentication"];
    result.nextAction = { kind: "open_url", url };
    result.retryAfterSeconds = 10;
    return result;
  }
  if (typeof data.repoId !== "string" || !data.repoId) return fail("Connection response did not identify a repository.");
  const status = await services.status(data.repoId);
  if (!status.ok) return apiFailure(status.status, "read repository status");
  const raw = status.data as { repo?: Record<string, unknown> } | null;
  const repo = raw?.repo;
  if (!repo || repo.id !== data.repoId || repo.provider !== "github" || typeof repo.fullName !== "string" || repo.fullName.toLowerCase() !== context.repository.toLowerCase()) {
    return fail("The server status did not match the requested GitHub repository.");
  }
  if (typeof repo.indexStatus !== "string" || typeof repo.analysisStatus !== "string") return fail("Repository status is incomplete.");
  if (repo.indexStatus === "failed" || repo.analysisStatus === "failed") {
    return fail("A repository job failed. Inspect its error before retrying; setup has not restarted the failed job.");
  }
  const completed = ["authentication", "connection"];
  const wait = (state: "indexing" | "analyzing", message: string) => {
    const result = onboardingResult(context, state, message);
    result.completed = completed;
    result.nextAction = { kind: "retry" };
    result.retryAfterSeconds = 10;
    return result;
  };
  if (repo.indexStatus === "indexing") return wait("indexing", "Indexing is running. Resume to check progress.");
  if (repo.indexStatus !== "indexed") {
    if (!["pending", "none"].includes(repo.indexStatus)) return fail("Unrecognised index state. Inspect repository status before continuing.");
    const started = await services.start(data.repoId, "index");
    if (!started.ok && started.status !== 409) return apiFailure(started.status, "start indexing");
    return wait("indexing", "Indexing requested or already running. Resume to verify completion.");
  }
  completed.push("indexing");
  if (repo.analysisStatus === "analyzing") return wait("analyzing", "Analysis is running. Resume to check progress.");
  if (["analyzed", "done", "completed"].includes(repo.analysisStatus)) {
    if (typeof repo.analysis !== "string" || !repo.analysis.trim() || typeof repo.indexedAt !== "string" || !Number.isFinite(Date.parse(repo.indexedAt)) || typeof repo.analyzedAt !== "string" || !Number.isFinite(Date.parse(repo.analyzedAt)) || typeof repo.indexedFiles !== "number" || !Number.isFinite(repo.indexedFiles) || typeof repo.totalFiles !== "number" || !Number.isFinite(repo.totalFiles)) {
      return fail("The server reports completion but the analysis or completion evidence is missing.");
    }
    if (repo.indexedFiles < 1 || repo.totalFiles < repo.indexedFiles) return fail("No indexed source files or inconsistent file counts. Inspect repository status before continuing.");
    if (Date.parse(repo.analyzedAt) >= Date.parse(repo.indexedAt)) {
      const result = onboardingResult(context, "ready", "The repository is connected, indexed and analysed.");
      result.completed = [...completed, "analysis"];
      result.result = { indexedFiles: repo.indexedFiles, totalFiles: repo.totalFiles, indexedAt: repo.indexedAt, analyzedAt: repo.analyzedAt, analysis: repo.analysis };
      return result;
    }
  } else if (!["pending", "none"].includes(repo.analysisStatus)) {
    return fail("Unrecognised analysis state. Inspect repository status before continuing.");
  }
  const started = await services.start(data.repoId, "analyze");
  if (!started.ok && started.status !== 409) return apiFailure(started.status, "start analysis");
  return wait("analyzing", "Analysis requested or already running. Resume to verify completion.");
}
