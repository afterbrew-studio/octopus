import { parseIntegrationSetupStatus, parseRepositoryWebhookSetup } from "./integration-setup";

export type RepositoryReadiness = {
  status: "ready" | "needs_action" | "unconfirmed";
  message: string;
};

export function getRepositoryReadiness(input: {
  provider: string;
  connected: boolean;
  installationMatches?: boolean;
  connectorUnavailable?: boolean;
  setupStatus: unknown;
  webhookSetupStatus?: unknown;
}): RepositoryReadiness {
  if (!input.connected || input.installationMatches === false) {
    return { status: "needs_action", message: "Reconnect this repository's provider in Integrations, then sync repositories." };
  }
  if (input.connectorUnavailable) {
    return { status: "needs_action", message: "Restore the Forgejo connector connection before opening a pull request." };
  }
  const setup = parseIntegrationSetupStatus(input.setupStatus);
  if (setup.sync.status === "failed") {
    return { status: "needs_action", message: setup.sync.error || "Repository sync failed. Retry setup in Integrations." };
  }
  if (setup.sync.status !== "ready") {
    return { status: "unconfirmed", message: "Confirm repository access with Retry setup in Integrations." };
  }
  if (input.provider === "github") {
    return { status: "ready", message: "Repository access confirmed. The GitHub App handles PR events; your first review confirms delivery." };
  }
  if (input.provider === "forgejo") {
    return { status: "unconfirmed", message: "Repository access confirmed. Add the signed webhook shown in Integrations, then open a PR to confirm delivery." };
  }
  const webhook = input.provider === "gitlab"
    ? parseRepositoryWebhookSetup(input.webhookSetupStatus) : setup.webhook;
  if (webhook.status === "failed") {
    return { status: "needs_action", message: webhook.error || "Webhook setup failed. Retry setup in Integrations." };
  }
  if (webhook.status !== "ready") {
    return { status: "unconfirmed", message: "Webhook setup is not confirmed. Check this repository in Integrations before opening a PR." };
  }
  return { status: "ready", message: "Repository access and webhook configuration confirmed. Your first review confirms delivery." };
}

export function getPreparationProgress(indexStatus: string, analysisStatus: string) {
  if (indexStatus === "indexing") return { status: "working", message: "Preparing automatically: indexing repository files…" } as const;
  if (indexStatus === "failed") return { status: "failed", message: "Repository indexing failed. Open the repository to view the error and retry." } as const;
  if (analysisStatus === "analyzing") return { status: "working", message: "Preparing automatically: analyzing repository context…" } as const;
  if (analysisStatus === "failed") return { status: "failed", message: "Repository analysis failed. Open the repository to view the error and retry." } as const;
  if ((indexStatus === "indexed" || indexStatus === "stale") && ["analyzed", "completed"].includes(analysisStatus)) {
    return { status: "ready", message: indexStatus === "stale" ? "Repository context will refresh automatically on the next review." : "Repository context is prepared." } as const;
  }
  return { status: "waiting", message: "Octopus indexes and analyzes automatically when a review starts. You can open a PR without preparing an index manually." } as const;
}

/** Only provider origins already validated and stored by the integration are passed here. */
export function getOnboardingRepositoryUrl(provider: string, fullName: string, host?: string | null): string | null {
  const origin = provider === "github" ? "https://github.com"
    : provider === "bitbucket" ? "https://bitbucket.org" : host;
  if (!origin) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return `${url.origin}/${fullName.split("/").map(encodeURIComponent).join("/")}`;
  } catch {
    return null;
  }
}
