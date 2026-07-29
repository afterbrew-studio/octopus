import { NextRequest, NextResponse } from "next/server";

const publicPrefixes = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/blocked",
  "/brand",
  "/blog",
  "/bug-bounty",
  "/docs",
  "/status",
  "/not-a-rabbit",
  "/compare",
  "/vs-",
  // Public content/marketing + feed paths. These must never bounce anonymous
  // visitors or crawlers to /login; ones that aren't built yet then fall
  // through to a normal 404 instead of a 307→/login (#443). (Extensioned feeds
  // like /feed.xml already bypass the middleware via the matcher's dot rule.)
  "/careers",
  "/open-positions",
  "/jobs",
  "/feed",
  "/rss",
  "/api/auth",
  "/api/github",
  "/api/bitbucket/webhook",
  "/api/gitlab/webhook",
  "/api/pubby",
  "/api/version",
  "/api/invitations",
  "/api/slack/commands",
  "/api/stripe",
  "/api/cli",
  "/api/agent",
  "/api/presence",
  "/api/admin",
  "/api/newsletter",
  "/api/analyze-deps",
  "/api/blog",
  "/api/ask-octopus",
  "/api/status",
  "/api/health",
  "/api/ready",
];
const publicExact = ["/"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Password-auth routes (forgot/reset/change) only exist on self-hosted
  // builds. On the SaaS build (flag unset) send them to /login so password
  // auth is a clean no-op rather than a half-working surface.
  if (
    process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED !== "true" &&
    (pathname.startsWith("/forgot-password") ||
      pathname.startsWith("/reset-password") ||
      pathname.startsWith("/change-password"))
  ) {
    const appUrl =
      process.env.BETTER_AUTH_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      `http://${request.headers.get("host") || "localhost:3000"}`;
    return NextResponse.redirect(new URL("/login", appUrl));
  }

  if (
    publicExact.includes(pathname) ||
    publicPrefixes.some((path) => pathname.startsWith(path))
  ) {
    return NextResponse.next();
  }

  const sessionToken =
    request.cookies.get("better-auth.session_token")?.value ||
    request.cookies.get("__Secure-better-auth.session_token")?.value;

  if (!sessionToken) {
    // Use configured app URL to prevent redirect poisoning via X-Forwarded-Host
    const appUrl =
      process.env.BETTER_AUTH_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      `http://${request.headers.get("host") || "localhost:3000"}`;
    const loginUrl = new URL("/login", appUrl);
    const fullPath = pathname + request.nextUrl.search;
    if (fullPath !== "/dashboard") {
      loginUrl.searchParams.set("callbackUrl", fullPath);
    }
    return NextResponse.redirect(loginUrl);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
