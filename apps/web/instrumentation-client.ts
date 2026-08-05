// Browser Sentry init. The client DSN is build-time inlined via
// NEXT_PUBLIC_SENTRY_DSN — baked ONLY in the hosted build (from a repo var), so
// the public self-host image ships with no DSN and client Sentry stays off.
import * as Sentry from "@sentry/nextjs";
import { scrubEvent, parseRate } from "@/lib/sentry-scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: !!dsn,
  environment:
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    (process.env.NEXT_PUBLIC_OCTOPUS_SELF_HOSTED === "true" ? "self-hosted" : "production"),
  release: process.env.NEXT_PUBLIC_APP_VERSION,
  tracesSampleRate: parseRate(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE, 0.1),
  // Session Replay. This product handles payment + account data, so replays are
  // masked hard: no text, no inputs, no media is recorded. Sample a small % of
  // sessions but always keep the replay around an error.
  replaysSessionSampleRate: parseRate(
    process.env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_RATE,
    0.1,
  ),
  replaysOnErrorSampleRate: 1.0,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    }),
  ],
  sendDefaultPii: false,
  beforeSend: (event) => scrubEvent(event),
});

// Lets Sentry tie client-side navigations to server transactions (Next 15+/16).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
