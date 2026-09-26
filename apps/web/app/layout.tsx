import type { Metadata } from "next";
import { Geist, Geist_Mono, Public_Sans } from "next/font/google";
import { Suspense } from "react";
import { MarketingConsentControls } from "@/components/marketing-consent";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VersionChecker } from "@/components/version-checker";
import { GlobalErrorHandler } from "@/components/global-error-handler";
import { TopLoader } from "@/components/top-loader";
import "./globals.css";

const publicSans = Public_Sans({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE_URL = "https://octopus-review.ai";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "AI Code Review | Octopus | Every PR, Reviewed in Minutes",
    template: "%s | Octopus",
  },
  description:
    "Octopus reviews every pull request in minutes with AI. Works with GitHub, GitLab, Bitbucket, and Forgejo. Indexes your codebase, analyzes diffs, and posts severity-rated findings to catch bugs before they merge.",
  keywords: [
    "code review",
    "AI code review",
    "pull request review",
    "automated code review",
    "GitHub code review",
    "GitLab code review",
    "Bitbucket code review",
    "Forgejo code review",
    "codebase indexing",
    "severity-rated findings",
    "Claude",
    "OpenAI",
    "code quality",
  ],
  authors: [{ name: "Octopus" }],
  creator: "Octopus",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: "Octopus",
    title: "AI Code Review | Octopus | Every PR, Reviewed in Minutes",
    description:
      "Octopus reviews every pull request in minutes with AI. Works with GitHub, GitLab, Bitbucket, and Forgejo. Indexes your codebase, analyzes diffs, and posts severity-rated findings to catch bugs before they merge.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "Octopus — AI-Powered Automated Code Review",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Code Review | Octopus | Every PR, Reviewed in Minutes",
    description:
      "Octopus reviews every pull request in minutes with AI. Works with GitHub, GitLab, Bitbucket, and Forgejo. Catch bugs before they merge.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  alternates: {
    canonical: SITE_URL,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={publicSans.variable} suppressHydrationWarning>
      <head>
        <meta name="apple-mobile-web-app-title" content="Octopus" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TopLoader />
          <TooltipProvider>
            {children}
          </TooltipProvider>
          {process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED !== "true" && <Suspense fallback={null}><MarketingConsentControls /></Suspense>}
          <VersionChecker />
          <GlobalErrorHandler />
          <Toaster richColors />
        </ThemeProvider>
      </body>
    </html>
  );
}
