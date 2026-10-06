import { describe, expect, it } from "bun:test";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubBrowserEvent } from "@/lib/sentry-scrub";

function injectedWalletError(): ErrorEvent {
  return { exception: { values: [
    { type: "Error", value: "MetaMask extension not found", stacktrace: { frames: [{ filename: "app:///scripts/inpage.js", in_app: true }] } },
    { type: "i", value: "Failed to connect to MetaMask", stacktrace: { frames: [{ filename: "app:///scripts/inpage.js", in_app: true }] } },
  ] } };
}

describe("browser-only Sentry filtering", () => {
  it("drops the confirmed injected MetaMask error chain", () => {
    expect(scrubBrowserEvent(injectedWalletError())).toBeNull();
  });

  it("retains similar messages with application, mixed, unknown or absent frames", () => {
    for (const frames of [
      [{ filename: "https://octopus-review.ai/_next/static/chunks/app.js", in_app: true }],
      [{ filename: "app:///scripts/inpage.js" }, { filename: "app:///src/app.tsx", in_app: true }],
      [{ filename: "app:///unknown.js" }],
      [{}],
      [],
    ]) {
      const event = injectedWalletError();
      event.exception!.values![0]!.stacktrace = { frames };
      expect(scrubBrowserEvent(event)).toBe(event);
    }
    const noStack = injectedWalletError();
    delete noStack.exception!.values![0]!.stacktrace;
    expect(scrubBrowserEvent(noStack)).toBe(noStack);
  });

  it("retains partial signatures, extra exceptions and unrelated security/application errors", () => {
    const partial = injectedWalletError();
    partial.exception!.values!.pop();
    expect(scrubBrowserEvent(partial)).toBe(partial);
    const extra = injectedWalletError();
    extra.exception!.values!.push({ type: "Error", value: "application failure" });
    expect(scrubBrowserEvent(extra)).toBe(extra);
    for (const value of ["M_ID is undefined", "Failed to find Server Action", "Hydration failed", "BBResearchProbe", "Connection closed", "Failed to connect to MetaMask now"]) {
      const event: ErrorEvent = { exception: { values: [{ value, stacktrace: { frames: [{ filename: "app:///scripts/inpage.js" }] } }] } };
      expect(scrubBrowserEvent(event)).toBe(event);
    }
  });

  it("still scrubs credentials and request metadata from retained events", () => {
    const event: ErrorEvent = { request: { headers: { authorization: "test-secret" }, cookies: "test-cookie" }, extra: { apiKey: "test-key", stage: "request" } };
    expect(scrubBrowserEvent(event)).toBe(event);
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.extra).toEqual({ apiKey: "[redacted]", stage: "request" });
  });
});
