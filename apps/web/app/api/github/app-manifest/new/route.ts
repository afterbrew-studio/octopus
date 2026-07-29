import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { encryptJson } from "@/lib/crypto";
import { isGithubAppConfigured } from "@/lib/github-app-config";
import {
  GITHUB_MANIFEST_STATE_COOKIE,
  GITHUB_MANIFEST_STATE_TTL_MS,
  buildAppManifest,
  type GithubManifestState,
} from "@/lib/github-manifest-state";

const baseUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";

// GitHub org/user logins: alphanumeric or single hyphens, max 39 chars.
const GH_LOGIN_RX = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function htmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * GET /api/github/app-manifest/new — start the GitHub App Manifest flow
 * (self-hosted only). Returns an auto-submitting form that POSTs a prefilled
 * app manifest to github.com; GitHub redirects to /app-manifest/callback with a
 * one-time code. Gated to self-host + an org owner/admin, and refused if an App
 * is already configured (so we never clobber existing credentials).
 */
export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED !== "true") {
    return NextResponse.json({ error: "not_self_hosted" }, { status: 404 });
  }

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return NextResponse.redirect(new URL("/login", baseUrl));

  const cookieStore = await cookies();
  const orgId =
    request.nextUrl.searchParams.get("orgId") || cookieStore.get("current_org_id")?.value;
  if (!orgId) return NextResponse.redirect(new URL("/dashboard", baseUrl));

  // Only an owner/admin of the org may provision the platform's GitHub App.
  const membership = await prisma.organizationMember.findFirst({
    where: {
      userId: session.user.id,
      organizationId: orgId,
      role: { in: ["owner", "admin"] },
      deletedAt: null,
    },
    select: { organizationId: true },
  });
  if (!membership) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=manifest_forbidden", baseUrl),
    );
  }

  if (await isGithubAppConfigured()) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=manifest_already_configured", baseUrl),
    );
  }

  // Optional GitHub org to own the app; blank = personal account.
  const org = (request.nextUrl.searchParams.get("org") ?? "").trim();
  if (org && !GH_LOGIN_RX.test(org)) {
    return NextResponse.redirect(
      new URL("/settings/integrations?error=manifest_bad_org", baseUrl),
    );
  }

  const nonce = crypto.randomBytes(16).toString("base64url");
  const state = encryptJson({
    userId: session.user.id,
    orgId: membership.organizationId,
    org,
    nonce,
    exp: Date.now() + GITHUB_MANIFEST_STATE_TTL_MS,
  } satisfies GithubManifestState);

  // Globally-unique app name per GitHub's requirement.
  const name = `octopus-${crypto.randomBytes(5).toString("hex")}`;
  const manifest = buildAppManifest(baseUrl, name);

  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const actionUrl = `${action}?state=${encodeURIComponent(state)}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Creating GitHub App…</title></head>
<body style="font-family:system-ui;padding:2rem;color:#444">
<p>Redirecting to GitHub to create your Octopus GitHub App…</p>
<form id="f" method="post" action="${htmlAttr(actionUrl)}">
<input type="hidden" name="manifest" value="${htmlAttr(JSON.stringify(manifest))}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit();</script>
</body></html>`;

  const res = new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  res.cookies.set(GITHUB_MANIFEST_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(GITHUB_MANIFEST_STATE_TTL_MS / 1000),
  });
  return res;
}
