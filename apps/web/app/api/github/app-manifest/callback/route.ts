import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { decryptJson } from "@/lib/crypto";
import { saveGithubAppConfig, hasDbGithubApp } from "@/lib/github-app-config";
import { signInstallState } from "@/lib/github-install-state";
import {
  GITHUB_MANIFEST_STATE_COOKIE,
  type GithubManifestState,
} from "@/lib/github-manifest-state";

const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
const GITHUB_API = "https://api.github.com";

function errorRedirect(reason: string): NextResponse {
  const res = NextResponse.redirect(
    new URL(`/settings/integrations?error=manifest_${reason}`, baseUrl),
  );
  res.cookies.delete(GITHUB_MANIFEST_STATE_COOKIE);
  return res;
}

/**
 * GET /api/github/app-manifest/callback — finish the App Manifest flow.
 * GitHub redirects here with a one-time `code` after the user creates the App.
 * We validate the CSRF state, exchange the code for the App's credentials,
 * persist them (encrypted), then send the user straight into installing the App.
 */
export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED !== "true") {
    return NextResponse.json({ error: "not_self_hosted" }, { status: 404 });
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) return errorRedirect("failed");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    // Session expired between "Create" on GitHub and this callback: preserve the
    // one-time code + state through login so re-authenticating resumes the flow
    // instead of orphaning the just-created app. (The state cookie survives login.)
    const resume = `/api/github/app-manifest/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    return NextResponse.redirect(
      new URL(`/login?callbackUrl=${encodeURIComponent(resume)}`, baseUrl),
    );
  }

  // Validate state: decrypt, expiry, cookie-nonce (CSRF), then re-check the
  // caller is still an owner/admin of the org from the signed state.
  let payload: GithubManifestState;
  try {
    payload = decryptJson<GithubManifestState>(state);
  } catch {
    return errorRedirect("failed");
  }
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return errorRedirect("expired");
  }
  const cookieStore = await cookies();
  const cookieNonce = cookieStore.get(GITHUB_MANIFEST_STATE_COOKIE)?.value;
  if (!cookieNonce || cookieNonce !== payload.nonce) {
    return errorRedirect("failed");
  }
  if (payload.userId !== session.user.id) return errorRedirect("forbidden");

  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId: session.user.id,
      organizationId: payload.orgId,
      role: { in: ["owner", "admin"] },
      deletedAt: null,
    },
    select: { organizationId: true },
  });
  if (!membership) return errorRedirect("forbidden");

  // Re-check (fresh, non-memoized DB read) that no App has been provisioned
  // since this flow started — never clobber existing credentials (TOCTOU guard).
  // If one now exists, the app just created on GitHub is a harmless orphan the
  // admin can delete there.
  if (await hasDbGithubApp()) return errorRedirect("already_configured");

  // Exchange the one-time code for the new App's credentials. The code itself
  // authorizes this call, so no JWT/token is needed.
  let conv: {
    id: number;
    slug: string;
    html_url?: string;
    pem: string;
    webhook_secret?: string;
    client_id?: string;
    client_secret?: string;
  };
  try {
    const res = await fetch(`${GITHUB_API}/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      console.error(`[app-manifest] conversions failed: ${res.status}`);
      return errorRedirect("failed");
    }
    conv = await res.json();
  } catch (err) {
    console.error("[app-manifest] conversions error:", err);
    return errorRedirect("failed");
  }

  if (!conv?.id || !conv.slug || !conv.pem) {
    return errorRedirect("failed");
  }

  let saved: boolean;
  try {
    saved = await saveGithubAppConfig({
      appId: conv.id,
      slug: conv.slug,
      htmlUrl: conv.html_url ?? null,
      clientId: conv.client_id ?? null,
      privateKey: conv.pem,
      webhookSecret: conv.webhook_secret ?? null,
      clientSecret: conv.client_secret ?? null,
    });
  } catch (err) {
    console.error("[app-manifest] failed to persist app config:", err);
    return errorRedirect("failed");
  }
  // Conditional write lost to a concurrent flow — an App is already configured.
  if (!saved) return errorRedirect("already_configured");

  // Auto-continue: send the user to install the freshly-created App on their
  // repos. The install callback binds the installation to the org as usual.
  const installState = signInstallState({
    uid: session.user.id,
    oid: membership.organizationId,
    rt: "/settings/integrations",
  });
  const installUrl = new URL(`https://github.com/apps/${conv.slug}/installations/new`);
  installUrl.searchParams.set("state", installState);

  const res = NextResponse.redirect(installUrl.toString());
  res.cookies.delete(GITHUB_MANIFEST_STATE_COOKIE);
  return res;
}
