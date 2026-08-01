import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

// Mutable SystemConfig row the mocked prisma returns.
let sysRow: Record<string, unknown> | null = null;
mock.module("@octopus/db", () => ({
  prisma: {
    systemConfig: { findUnique: () => Promise.resolve(sysRow) },
  },
}));

const { getGithubAppConfig, clearGithubAppConfigCache } = await import(
  "@/lib/github-app-config"
);

// decryptStringMaybeLegacy returns its input unchanged when the value isn't
// valid ciphertext, so plaintext test values round-trip without a data key.
const ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "NEXT_PUBLIC_GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
];

beforeEach(() => {
  sysRow = null;
  clearGithubAppConfigCache();
  for (const k of ENV) delete process.env[k];
});

describe("getGithubAppConfig", () => {
  it("prefers a DB-configured app over env", async () => {
    sysRow = {
      githubAppId: "999",
      githubAppSlug: "octopus-db",
      githubAppClientId: "cid-db",
      githubAppHtmlUrl: "https://github.com/apps/octopus-db",
      githubAppPrivateKeyEnc: "PEM-DB",
      githubAppWebhookSecretEnc: "WH-DB",
      githubAppClientSecretEnc: "CS-DB",
    };
    process.env.GITHUB_APP_ID = "111";
    process.env.GITHUB_APP_PRIVATE_KEY = "PEM-ENV";
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "octopus-env";

    const c = await getGithubAppConfig();
    expect(c?.appId).toBe("999");
    expect(c?.slug).toBe("octopus-db");
    expect(c?.privateKey).toBe("PEM-DB");
    expect(c?.webhookSecret).toBe("WH-DB");
    expect(c?.clientId).toBe("cid-db");
    expect(c?.clientSecret).toBe("CS-DB");
    expect(c?.htmlUrl).toBe("https://github.com/apps/octopus-db");
  });

  it("falls back to env when there is no DB app", async () => {
    sysRow = null;
    process.env.GITHUB_APP_ID = "111";
    process.env.GITHUB_APP_PRIVATE_KEY = "PEM-ENV";
    process.env.GITHUB_WEBHOOK_SECRET = "WH-ENV";
    process.env.NEXT_PUBLIC_GITHUB_APP_SLUG = "octopus-env";
    process.env.GITHUB_APP_CLIENT_ID = "cid-env";
    process.env.GITHUB_APP_CLIENT_SECRET = "cs-env";

    const c = await getGithubAppConfig();
    expect(c?.appId).toBe("111");
    expect(c?.slug).toBe("octopus-env");
    expect(c?.privateKey).toBe("PEM-ENV");
    expect(c?.webhookSecret).toBe("WH-ENV");
    expect(c?.clientId).toBe("cid-env");
    expect(c?.clientSecret).toBe("cs-env");
    expect(c?.htmlUrl).toBeNull();
  });

  it("ignores a partial DB row (id without key) and uses env", async () => {
    sysRow = { githubAppId: "999", githubAppPrivateKeyEnc: null };
    process.env.GITHUB_APP_ID = "111";
    process.env.GITHUB_APP_PRIVATE_KEY = "PEM-ENV";
    const c = await getGithubAppConfig();
    expect(c?.appId).toBe("111");
  });

  it("returns null when neither DB nor env is configured", async () => {
    sysRow = null;
    expect(await getGithubAppConfig()).toBeNull();
  });
});
