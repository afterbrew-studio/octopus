import "server-only";
import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";
import { auth } from "@/lib/auth";
import { syncOrgRepos } from "@/lib/repo-sync";
import { withWebhookSetupLock } from "@/lib/integration-setup-lock";
import { parseIntegrationSetupStatus } from "@/lib/integration-setup";
import { encryptString } from "@/lib/crypto";
import {
  integrationOAuthStateCookie,
  verifyIntegrationOAuthState,
} from "@/lib/integration-oauth-state";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.BETTER_AUTH_URL || request.url;
  const code = request.nextUrl.searchParams.get("code");
  const stateParam = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const cookieStore = await cookies();
  const stateCookie = integrationOAuthStateCookie("bitbucket");
  const cookieNonce = cookieStore.get(stateCookie)?.value;
  cookieStore.delete(stateCookie);

  if (error) {
    console.error("[bitbucket-callback] OAuth error:", error);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=bitbucket_denied", baseUrl),
    );
  }

  if (!code || !stateParam) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=missing_params", baseUrl),
    );
  }

  const verified = verifyIntegrationOAuthState({
    state: stateParam,
    cookieNonce,
    provider: "bitbucket",
  });
  if (!verified.ok) {
    return NextResponse.redirect(
      new URL(`/settings/integrations?error=${verified.error}`, baseUrl),
    );
  }
  const { orgId, userId } = verified.state;
  const workspaceSlug = verified.state.context?.workspaceSlug;
  if (!workspaceSlug) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=invalid_state", baseUrl),
    );
  }

  // Verify the user is authenticated
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=unauthorized", baseUrl),
    );
  }
  if (session.user.id !== userId) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=forbidden", baseUrl),
    );
  }

  // Verify the user is an admin/owner of this org
  const member = await prisma.organizationMember.findFirst({
    where: { userId: session.user.id, organizationId: orgId, deletedAt: null },
    select: { role: true, scopes: true },
  });

  if (!member || !hasOrgPermission(member, "integrations:manage")) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=insufficient_role", baseUrl),
    );
  }

  // Validate environment variables
  const clientId = process.env.BITBUCKET_CLIENT_ID;
  const clientSecret = process.env.BITBUCKET_CLIENT_SECRET;
  const redirectUri = process.env.BITBUCKET_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[bitbucket-callback] Missing Bitbucket OAuth environment variables");
    return NextResponse.redirect(
      new URL("/settings/integrations?error=not_configured", baseUrl),
    );
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(
    "https://bitbucket.org/site/oauth2/access_token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      }),
    },
  );

  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || tokenData.error) {
    console.error("[bitbucket-callback] Token exchange failed:", tokenData);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=token_exchange", baseUrl),
    );
  }

  const accessToken = tokenData.access_token as string | undefined;
  const refreshToken = tokenData.refresh_token as string | undefined;

  if (!accessToken || !refreshToken) {
    console.error("[bitbucket-callback] Missing tokens in response");
    return NextResponse.redirect(
      new URL("/settings/integrations?error=token_exchange", baseUrl),
    );
  }

  const expiresIn = (tokenData.expires_in as number) ?? 7200; // default 2 hours
  const scopes = (tokenData.scopes as string) ?? null;
  const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

  // Cross-workspace listing APIs were removed by Bitbucket (CHANGE-2770, April 2026).
  // Workspace slug is provided by the user before OAuth and passed via state.
  // Verify the workspace actually exists and the token has access to it.
  const workspaceRes = await fetch(
    `https://api.bitbucket.org/2.0/workspaces/${encodeURIComponent(workspaceSlug)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!workspaceRes.ok) {
    const errBody = await workspaceRes.text().catch(() => "");
    console.error("[bitbucket-callback] Workspace not found or inaccessible:", workspaceRes.status, errBody);
    return NextResponse.redirect(
      new URL("/settings/integrations?error=workspace_not_found", baseUrl),
    );
  }

  const workspaceData = await workspaceRes.json();
  const workspaceName = (workspaceData.name as string) || workspaceSlug;

  let saved: boolean;
  try {
    saved = await withWebhookSetupLock(`binding:bitbucket:${orgId}`, async (tx) => {
      const existing = await tx.bitbucketIntegration.findUnique({ where: { organizationId: orgId } });
      if (existing && (existing.workspaceSlug !== workspaceSlug)) return false;
      const webhookSecret = existing ? existing.webhookSecret : crypto.randomBytes(32).toString("hex");

      const accessTokenEnc = encryptString(accessToken);
      const refreshTokenEnc = encryptString(refreshToken);
      await tx.bitbucketIntegration.upsert({
        where: { organizationId: orgId },
        create: {
          workspaceSlug,
          workspaceName,
          accessToken: accessTokenEnc,
          refreshToken: refreshTokenEnc,
          tokenExpiresAt,
          scopes,
          webhookSecret,
          organizationId: orgId,
        },
        update: {
          workspaceSlug,
          workspaceName,
          accessToken: accessTokenEnc,
          refreshToken: refreshTokenEnc,
          tokenExpiresAt,
          scopes,
          webhookSecret,
          webhookUuid: existing?.workspaceSlug === workspaceSlug ? existing.webhookUuid : null,
          setupStatus: parseIntegrationSetupStatus(null),
        },
      });
      if (!existing) await tx.repository.updateMany({
        where: { organizationId: orgId, provider: "bitbucket" },
        data: { webhookSetupStatus: { status: "unknown" }, isActive: false },
      });
      return true;
    });
  } catch {
    return NextResponse.redirect(new URL("/settings/integrations?error=connection_busy", baseUrl));
  }
  if (!saved) return NextResponse.redirect(new URL("/settings/integrations?error=connection_replacement", baseUrl));

  // Authorization succeeded; setup has a separate durable outcome.
  let setupFailed = false;
  try {
    const result = await syncOrgRepos(orgId, { source: "manual", providers: ["bitbucket"] });
    setupFailed = Boolean(result.error);
  } catch {
    setupFailed = true;
  }
  return NextResponse.redirect(new URL(
    `/settings/integrations?authorized=bitbucket${setupFailed ? "&setup=attention" : ""}`,
    baseUrl,
  ));
}
