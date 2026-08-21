import type { Metadata } from "next";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { LandingFooter } from "@/components/landing-footer";
import { LandingMobileNav } from "@/components/landing-mobile-nav";
import { LandingDesktopNav } from "@/components/landing-desktop-nav";
import { FaqList } from "@/components/FaqList";
import { Section, SectionHeader } from "@/components/landing-section";
import {
  IconSparkles,
  IconBug,
  IconShieldCheck,
  IconMessageCircle,
  IconBolt,
  IconTerminal2,
  IconPlugConnected,
  IconKey,
  IconArrowRight,
} from "@tabler/icons-react";

export const metadata: Metadata = {
  title: "Octopus in your editor — code review for Cursor & Claude Code",
  description:
    "Building with AI? Octopus reviews the code your AI writes for real bugs and security issues, right inside Cursor and Claude Code, and explains what it finds in plain English.",
  alternates: {
    canonical: "https://octopus-review.ai/editor",
  },
};

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

const benefits = [
  {
    icon: IconBug,
    title: "Finds real bugs",
    description:
      "Not style nitpicks. Octopus looks for actual problems: broken logic, missing checks, and the kind of thing that quietly breaks later.",
  },
  {
    icon: IconShieldCheck,
    title: "Catches security holes",
    description:
      "Leaked secrets, unsafe database queries, doors an attacker could walk through. Octopus flags them before they ever go live.",
  },
  {
    icon: IconMessageCircle,
    title: "Explains it in plain English",
    description:
      "Every finding tells you what is wrong and how to fix it, in language you can actually follow. Ask a follow-up question any time.",
  },
  {
    icon: IconBolt,
    title: "No pull request needed",
    description:
      "Review what you are working on right now. Nothing to open on GitHub, no waiting on a teammate.",
  },
];

const steps = [
  {
    n: "1",
    title: "Add the plugin",
    description:
      "Install Octopus in Cursor or Claude Code. Both take a moment, and the steps are right below.",
  },
  {
    n: "2",
    title: "Connect your account",
    description:
      "Paste a free token from your Octopus settings when the plugin asks. That is the whole setup.",
  },
  {
    n: "3",
    title: "Just ask",
    description:
      "Say “review my changes” or ask a question about your code. Octopus takes it from there.",
  },
];

const exampleFindings = [
  {
    level: "Critical",
    color: "bg-red-500",
    text: "Passwords are saved without scrambling them. Anyone who sees the database could read them.",
  },
  {
    level: "Warning",
    color: "bg-orange-500",
    text: "This form does not check what the user typed, so it could receive unexpected data.",
  },
  {
    level: "Suggestion",
    color: "bg-yellow-500",
    text: "The same code is copied in three places. A shared helper would be easier to maintain.",
  },
];

const faqs = [
  {
    q: "Do I need to be a developer to use this?",
    a: "No. If you are building something with AI in Cursor or Claude Code, you can use Octopus. It reads the code for you and explains what it finds in plain language.",
  },
  {
    q: "Which editors does it work with?",
    a: "Cursor and Claude Code today, plus any editor that supports the same kind of plugin. More are on the way.",
  },
  {
    q: "Is it free to try?",
    a: "Yes. New accounts come with free credits, and you can bring your own AI provider key to run reviews at no platform cost. See the pricing page for details.",
  },
  {
    q: "Does my code get sent anywhere?",
    a: "Octopus only reviews the specific changes you ask it to, and uses them to give you feedback. Our security and privacy docs explain exactly how your code is handled.",
  },
  {
    q: "How is this different from the AI already in my editor?",
    a: "Your editor's AI writes code. Octopus checks it. It is a dedicated reviewer looking for bugs and security issues, with the context of your whole project and your past reviews.",
  },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default async function EditorPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  return (
    <div className="dark relative min-h-screen bg-[#0c0c0c] text-[#a0a0a0] selection:bg-white/20">
      {/* Grain overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.025]"
        aria-hidden="true"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* Navigation */}
      <LandingMobileNav isLoggedIn={!!session} />
      <LandingDesktopNav isLoggedIn={!!session} />

      {/* Hero */}
      <section className="relative z-10 px-6 pb-16 pt-28 md:px-8 md:pb-24 md:pt-40">
        <div className="mx-auto max-w-4xl text-center">
          <div className="animate-fade-in mb-6 inline-flex items-center gap-2 rounded-full border border-teal-500/20 bg-teal-500/10 px-4 py-1.5 text-sm text-teal-400">
            <IconPlugConnected className="size-4" />
            Editor plugin
          </div>
          <h1 className="animate-fade-in text-4xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl">
            Octopus, right inside your editor
          </h1>
          <p className="animate-fade-in mx-auto mt-4 max-w-2xl text-lg text-[#666] [animation-delay:100ms]">
            Building with AI in Cursor or Claude Code? Octopus reads the code
            your AI writes, finds the real bugs and security holes, and explains
            them in plain English, before any of it goes live.
          </p>
          <div className="animate-fade-in mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row [animation-delay:200ms]">
            <a
              href="#install"
              className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-[#0c0c0c] transition-colors hover:bg-[#e0e0e0]"
            >
              Add it to your editor
            </a>
            <a
              href="#catches"
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-6 py-3 text-sm font-medium text-[#ccc] transition-colors hover:border-white/[0.2] hover:text-white"
            >
              See what it catches
            </a>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <Section>
        <SectionHeader
          label="Why it helps"
          title="A second set of eyes on everything you build"
          description="Your editor's AI is great at writing code fast. Octopus is the reviewer that checks it for the things that matter."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {benefits.map((b) => (
            <div
              key={b.title}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 transition-colors hover:border-white/[0.12]"
            >
              <b.icon className="size-6 text-teal-400" />
              <h3 className="mt-3 text-base font-semibold text-white">{b.title}</h3>
              <p className="mt-2 text-sm text-[#888]">{b.description}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* How it works */}
      <Section id="how">
        <SectionHeader label="How it works" title="Three steps, then just ask" />
        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6"
            >
              <div className="flex size-9 items-center justify-center rounded-full border border-teal-500/20 bg-teal-500/10 text-sm font-semibold text-teal-400">
                {s.n}
              </div>
              <h3 className="mt-4 text-base font-semibold text-white">{s.title}</h3>
              <p className="mt-2 text-sm text-[#888]">{s.description}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* What it catches */}
      <Section id="catches">
        <SectionHeader
          label="What it catches"
          title="Here is what a review looks like"
          description="You ask for a review and Octopus replies with clear, ranked findings. No jargon required."
        />
        <div className="mt-10 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0c0c0c]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-5 py-3">
            <IconMessageCircle className="size-4 text-teal-400" />
            <span className="text-sm font-medium text-white">Octopus review</span>
            <span className="ml-auto font-mono text-xs text-[#555]">src/login.js</span>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {exampleFindings.map((f) => (
              <div key={f.level} className="flex items-start gap-3 px-5 py-4">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${f.color}`}
                  aria-hidden="true"
                />
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide text-[#888]">
                    {f.level}
                  </span>
                  <p className="mt-0.5 text-sm text-[#ccc]">{f.text}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* Install */}
      <Section id="install">
        <SectionHeader
          label="Get started"
          title="Add Octopus to your editor"
          description="Pick your editor. Setup takes about a minute, and you only do it once."
        />
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {/* Claude Code */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6">
            <div className="flex items-center gap-2">
              <IconTerminal2 className="size-5 text-teal-400" />
              <h3 className="text-base font-semibold text-white">Claude Code</h3>
            </div>
            <p className="mt-2 text-sm text-[#888]">
              Run these two commands inside Claude Code:
            </p>
            <div className="mt-3 space-y-2">
              <code className="block overflow-x-auto rounded-lg border border-white/[0.06] bg-[#0c0c0c] px-3 py-2 font-mono text-xs text-[#ccc]">
                /plugin marketplace add octopusreview/octopus-plugin
              </code>
              <code className="block overflow-x-auto rounded-lg border border-white/[0.06] bg-[#0c0c0c] px-3 py-2 font-mono text-xs text-[#ccc]">
                /plugin install octopus-review
              </code>
            </div>
          </div>
          {/* Cursor */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6">
            <div className="flex items-center gap-2">
              <IconSparkles className="size-5 text-teal-400" />
              <h3 className="text-base font-semibold text-white">Cursor</h3>
            </div>
            <p className="mt-2 text-sm text-[#888]">
              Open Cursor&apos;s plugin marketplace, search for{" "}
              <span className="text-[#ccc]">Octopus Code Review</span>, and click
              Install.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-5">
          <IconKey className="mt-0.5 size-5 shrink-0 text-teal-400" />
          <p className="text-sm text-[#888]">
            You&apos;ll need a free token. Create one in your{" "}
            <a
              href="/settings/api-tokens"
              className="text-teal-400 underline decoration-teal-400/30 underline-offset-2 transition-colors hover:text-teal-300 hover:decoration-teal-300"
            >
              Octopus settings
            </a>{" "}
            under API Tokens, then paste it when the plugin asks. New accounts
            start with free credits.
          </p>
        </div>
      </Section>

      {/* FAQ */}
      <Section id="faq">
        <SectionHeader label="FAQ" title="Frequently asked questions" />
        <FaqList faqs={faqs} visibleCount={5} />
      </Section>

      {/* Final CTA */}
      <section className="relative z-10 px-6 py-16 md:px-8 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Catch the bugs before they ship
          </h2>
          <p className="mt-3 text-[#888]">
            Add Octopus to your editor and get a plain-English review of your
            code whenever you want one.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="#install"
              className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-medium text-[#0c0c0c] transition-colors hover:bg-[#e0e0e0]"
            >
              Add it to your editor
              <IconArrowRight className="size-3.5" />
            </a>
            <a
              href="/docs/getting-started"
              className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] px-6 py-3 text-sm font-medium text-[#ccc] transition-colors hover:border-white/[0.2] hover:text-white"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>

      <LandingFooter />
    </div>
  );
}
