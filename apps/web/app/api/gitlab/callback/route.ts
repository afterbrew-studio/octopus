import "server-only";
import crypto from "node:crypto";
import { readBoundedJson, isPostgresSafeText } from "@/lib/bounded-json";
import { NextRequest, NextResponse } from "next/server";
import { headers, cookies } from "next/headers";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";
import { auth } from "@/lib/auth";
import { syncOrgRepos } from "@/lib/repo-sync";
import { withWebhookSetupLock } from "@/lib/integration-setup-lock";
import { parseIntegrationSetupStatus } from "@/lib/integration-setup";
import { decryptJson, encryptString } from "@/lib/crypto";

const GITLAB_OAUTH_INIT_COOKIE = "gitlab_oauth_init";
const COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

type InitPayload = {
  nonce: string;
  orgId: string;
  namespacePath: string;
  gitlabHost: string;
  clientId: string;
  clientSecret: string | null;
  issuedAt: number;
};

// Only provider I/O is caught here; application/auth/database faults stay observable.
async function readGitlabResponse(url: string, init: RequestInit, stage: "token" | "group" | "user") {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.error("[gitlab-callback] Provider request rejected", { stage, status: response.status });
      return { ok: false as const, status: response.status };
    }
    const parsed = await readBoundedJson(response, 1024 * 1024);
    if (!parsed.ok) {
      console.error("[gitlab-callback] Invalid provider response", { stage, reason: parsed.reason });
      return { ok: false as const };
    }
    return { ok: true as const, data: parsed.value };
  } catch (error) {
    // Do not log error messages, URLs or response bodies: they can contain credentials.
    console.error("[gitlab-callback] Provider request failed", {
      stage, reason: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "network",
    });
    return { ok: false as const };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && isPostgresSafeText(value);
}

export async function GET(request: NextRequest) {
  const baseUrl = process.env.BETTER_AUTH_URL || request.url;
  const code = request.nextUrl.searchParams.get("code");
  const stateParam = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  const cookieStore = await cookies();
  const initCookieValue = cookieStore.get(GITLAB_OAUTH_INIT_COOKIE)?.value;
  // Always clear the init cookie — single-use even on error
  cookieStore.delete(GITLAB_OAUTH_INIT_COOKIE);

  if (error) {
    console.error("[gitlab-callback] OAuth authorization denied");
    return NextResponse.redirect(
      new URL("/settings/integrations?error=gitlab_denied", baseUrl),
    );
  }

  if (!code || !stateParam || !initCookieValue) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=missing_params", baseUrl),
    );
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=unauthorized", baseUrl),
    );
  }

  let stateNonce: string;
  try {
    const parsed = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf-8"));
    stateNonce = parsed.nonce;
    if (!stateNonce) throw new Error("Missing nonce");
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=invalid_state", baseUrl),
    );
  }

  let init: InitPayload;
  try {
    init = decryptJson<InitPayload>(initCookieValue);
  } catch {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=invalid_init", baseUrl),
    );
  }

  if (init.nonce !== stateNonce) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=state_mismatch", baseUrl),
    );
  }
  if (Date.now() - init.issuedAt > COOKIE_MAX_AGE_MS) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=init_expired", baseUrl),
    );
  }

  const { orgId, namespacePath, gitlabHost, clientId, clientSecret } = init;

  const member = await prisma.organizationMember.findFirst({
    where: { userId: session.user.id, organizationId: orgId, deletedAt: null },
    select: { role: true, scopes: true },
  });
  if (!member || !hasOrgPermission(member, "integrations:manage")) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=forbidden", baseUrl),
    );
  }

  // Resolve the secret used for the token exchange: prefer per-org from cookie,
  // else env default (gitlab.com cloud).
  const effectiveClientSecret = clientSecret ?? process.env.GITLAB_CLIENT_SECRET;
  const redirectUri = process.env.GITLAB_REDIRECT_URI;
  if (!effectiveClientSecret || !redirectUri) {
    console.error("[gitlab-callback] Missing GitLab OAuth secret or redirect URI");
    return NextResponse.redirect(
      new URL("/settings/integrations?error=not_configured", baseUrl),
    );
  }

  const tokenResponse = await readGitlabResponse(`${gitlabHost}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: effectiveClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  }, "token");

  const tokenData = tokenResponse.ok ? tokenResponse.data : null;
  if (!isObject(tokenData) || tokenData.error ||
      !isNonemptyText(tokenData.access_token) || !isNonemptyText(tokenData.refresh_token) ||
      (tokenData.expires_in != null && (typeof tokenData.expires_in !== "number" || !Number.isFinite(tokenData.expires_in) || tokenData.expires_in <= 0)) ||
      (tokenData.scope != null && (typeof tokenData.scope !== "string" || !isPostgresSafeText(tokenData.scope)))) {
    console.error("[gitlab-callback] Invalid token response");
    return NextResponse.redirect(new URL("/settings/integrations?error=token_exchange", baseUrl));
  }

  const accessToken = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;
  const tokenExpiresAt = new Date(Date.now() + ((tokenData.expires_in as number | undefined) ?? 7200) * 1000);
  const scopes = (tokenData.scope as string | undefined) ?? null;
  if (!Number.isFinite(tokenExpiresAt.getTime())) {
    console.error("[gitlab-callback] Invalid token expiry");
    return NextResponse.redirect(new URL("/settings/integrations?error=token_exchange", baseUrl));
  }

  // Verify the namespace before persisting any credentials.
  const apiBase = `${gitlabHost.replace(/\/+$/, "")}/api/v4`;
  const authorization = { headers: { Authorization: `Bearer ${accessToken}` } };
  let namespaceName: string;
  const group = await readGitlabResponse(`${apiBase}/groups/${encodeURIComponent(namespacePath)}`, authorization, "group");
  if (group.ok && isObject(group.data) && isNonemptyText(group.data.name)) {
    namespaceName = group.data.name;
  } else if (!group.ok && group.status === 404) {
    const users = await readGitlabResponse(`${apiBase}/users?username=${encodeURIComponent(namespacePath)}`, authorization, "user");
    const user = users.ok && Array.isArray(users.data) ? users.data[0] : null;
    if (!isObject(user) || !isNonemptyText(user.name)) {
      console.error("[gitlab-callback] Invalid or missing user namespace");
      return NextResponse.redirect(new URL("/settings/integrations?error=namespace_not_found", baseUrl));
    }
    namespaceName = user.name;
  } else {
    console.error("[gitlab-callback] Invalid or unavailable group namespace");
    return NextResponse.redirect(new URL("/settings/integrations?error=namespace_not_found", baseUrl));
  }

  let saved: boolean;
  try {
    saved = await withWebhookSetupLock(`binding:gitlab:${orgId}`, async (tx) => {
      const existing = await tx.gitlabIntegration.findUnique({ where: { organizationId: orgId } });
      if (existing && (existing.gitlabHost !== gitlabHost || existing.namespacePath !== namespacePath)) return false;
      const webhookSecret = existing ? existing.webhookSecret : crypto.randomBytes(32).toString("hex");

      const persistOauthClientId = clientSecret ? clientId : null;
      const persistOauthClientSecretEnc = clientSecret ? encryptString(clientSecret) : null;
      const accessTokenEnc = encryptString(accessToken);
      const refreshTokenEnc = encryptString(refreshToken);

      await tx.gitlabIntegration.upsert({
        where: { organizationId: orgId },
        create: {
          gitlabHost,
          namespacePath,
          namespaceName,
          oauthClientId: persistOauthClientId,
          oauthClientSecretEnc: persistOauthClientSecretEnc,
          accessToken: accessTokenEnc,
          refreshToken: refreshTokenEnc,
          tokenExpiresAt,
          scopes,
          webhookSecret,
          organizationId: orgId,
        },
        update: {
          gitlabHost,
          namespacePath,
          namespaceName,
          oauthClientId: persistOauthClientId,
          oauthClientSecretEnc: persistOauthClientSecretEnc,
          accessToken: accessTokenEnc,
          refreshToken: refreshTokenEnc,
          tokenExpiresAt,
          scopes,
          webhookSecret,
          setupStatus: parseIntegrationSetupStatus(null),
        },
      });
      if (!existing) await tx.repository.updateMany({
        where: { organizationId: orgId, provider: "gitlab" },
        data: { webhookSetupStatus: { status: "unknown" }, isActive: false },
      });
      return true;
    });
  } catch {
    return NextResponse.redirect(new URL("/settings/integrations?error=connection_busy", baseUrl));
  }
  if (!saved) return NextResponse.redirect(new URL("/settings/integrations?error=connection_replacement", baseUrl));

  let setupFailed = false;
  try {
    const result = await syncOrgRepos(orgId, { source: "manual", providers: ["gitlab"] });
    setupFailed = Boolean(result.error);
  } catch {
    setupFailed = true;
  }
  return NextResponse.redirect(new URL(
    `/settings/integrations?authorized=gitlab${setupFailed ? "&setup=attention" : ""}`,
    baseUrl,
  ));
}
