/** Serializable setup evidence. Authorization and actual webhook delivery are separate. */
export type SetupCheck = {
  status: "unknown" | "ready" | "failed";
  checkedAt: string | null;
  error: string | null;
};

export type IntegrationSetupStatus = {
  sync: SetupCheck;
  webhook: Omit<SetupCheck, "status"> & { status: SetupCheck["status"] | "manual" };
};

export type RepositoryWebhookSetup = SetupCheck & { hookId: string | null; hookScope: string | null };

/** Only these deliberate, credential-free messages may be persisted for users. */
export class WebhookSetupError extends Error {}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function check(value: unknown): SetupCheck {
  const row = object(value);
  const status = row.status === "ready" || row.status === "failed" ? row.status : "unknown";
  return {
    status,
    checkedAt: typeof row.checkedAt === "string" && Number.isFinite(Date.parse(row.checkedAt)) ? row.checkedAt : null,
    error: typeof row.error === "string" ? row.error : null,
  };
}

export function parseIntegrationSetupStatus(value: unknown): IntegrationSetupStatus {
  const row = object(value);
  const webhook = check(row.webhook);
  return {
    sync: check(row.sync),
    webhook: { ...webhook, status: object(row.webhook).status === "manual" ? "manual" : webhook.status },
  };
}

export function parseRepositoryWebhookSetup(value: unknown): RepositoryWebhookSetup {
  const row = object(value);
  return { ...check(row), hookId: typeof row.hookId === "string" ? row.hookId : null,
    hookScope: typeof row.hookScope === "string" ? row.hookScope : null };
}
