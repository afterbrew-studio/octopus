import "server-only";
import { prisma } from "@octopus/db";
import { encryptString, decryptStringMaybeLegacy } from "@/lib/crypto";

/**
 * Resolved GitHub App credentials. Source is the SystemConfig singleton when a
 * self-hoster provisioned an App via the manifest flow (lib/github-app-config
 * saveGithubAppConfig), otherwise the GITHUB_APP_* / NEXT_PUBLIC_GITHUB_APP_SLUG
 * env vars (cloud + manually-configured self-host). DB wins over env.
 */
export type GithubAppConfig = {
  appId: string;
  privateKey: string;
  webhookSecret: string | null;
  slug: string | null;
  clientId: string | null;
  htmlUrl: string | null;
};

// Small in-process memo so we don't hit the DB on every GitHub API call /
// webhook. Invalidated explicitly after a manifest write (clearCache).
const TTL_MS = 30_000;
let cache: { value: GithubAppConfig | null; at: number } | null = null;

export function clearGithubAppConfigCache(): void {
  cache = null;
}

function fromEnv(): GithubAppConfig | null {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) return null;
  return {
    appId,
    privateKey,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? null,
    slug: process.env.NEXT_PUBLIC_GITHUB_APP_SLUG ?? null,
    clientId: process.env.GITHUB_CLIENT_ID ?? null,
    htmlUrl: null,
  };
}

async function resolve(): Promise<GithubAppConfig | null> {
  // DB-first: a manifest-provisioned App overrides env. On any DB error, fall
  // back to env rather than breaking every GitHub call (mirrors review-effort).
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { id: "singleton" },
      select: {
        githubAppId: true,
        githubAppSlug: true,
        githubAppClientId: true,
        githubAppHtmlUrl: true,
        githubAppPrivateKeyEnc: true,
        githubAppWebhookSecretEnc: true,
      },
    });
    if (row?.githubAppId && row.githubAppPrivateKeyEnc) {
      return {
        appId: row.githubAppId,
        privateKey: decryptStringMaybeLegacy(row.githubAppPrivateKeyEnc),
        webhookSecret: row.githubAppWebhookSecretEnc
          ? decryptStringMaybeLegacy(row.githubAppWebhookSecretEnc)
          : null,
        slug: row.githubAppSlug,
        clientId: row.githubAppClientId,
        htmlUrl: row.githubAppHtmlUrl,
      };
    }
  } catch (err) {
    console.error("[github-app-config] DB read failed, falling back to env:", err);
  }
  return fromEnv();
}

/** Resolved GitHub App config (DB-first, env fallback), memoized ~30s. */
export async function getGithubAppConfig(): Promise<GithubAppConfig | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const value = await resolve();
  cache = { value, at: Date.now() };
  return value;
}

/** Whether a GitHub App is configured at all (DB or env). */
export async function isGithubAppConfigured(): Promise<boolean> {
  return (await getGithubAppConfig()) !== null;
}

/** Whether an App is configured specifically in the DB (manifest-provisioned). */
export async function hasDbGithubApp(): Promise<boolean> {
  try {
    const row = await prisma.systemConfig.findUnique({
      where: { id: "singleton" },
      select: { githubAppId: true },
    });
    return Boolean(row?.githubAppId);
  } catch {
    return false;
  }
}

export type SaveGithubAppInput = {
  appId: string | number;
  slug: string;
  htmlUrl?: string | null;
  clientId?: string | null;
  privateKey: string; // PEM
  webhookSecret?: string | null;
  clientSecret?: string | null;
};

/** Persist manifest-provisioned App credentials (secrets encrypted) + clear the memo. */
export async function saveGithubAppConfig(input: SaveGithubAppInput): Promise<void> {
  const data = {
    githubAppId: String(input.appId),
    githubAppSlug: input.slug,
    githubAppHtmlUrl: input.htmlUrl ?? null,
    githubAppClientId: input.clientId ?? null,
    githubAppPrivateKeyEnc: encryptString(input.privateKey),
    githubAppWebhookSecretEnc: input.webhookSecret ? encryptString(input.webhookSecret) : null,
    githubAppClientSecretEnc: input.clientSecret ? encryptString(input.clientSecret) : null,
  };
  await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });
  clearGithubAppConfigCache();
}
