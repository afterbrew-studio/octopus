import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

const { splitReasoning } = await import("@/lib/providers/reasoning");

describe("splitReasoning", () => {
  it("leaves an ordinary answer alone", () => {
    const got = splitReasoning("## Findings\n\nNothing to report.");
    expect(got.text).toBe("## Findings\n\nNothing to report.");
    expect(got.strippedReasoning).toBe(false);
    expect(got.truncatedInReasoning).toBe(false);
  });

  it("removes an inline <think> block and keeps the answer", () => {
    // The exact shape MiniMax returned when a 32k-character chain of thought was
    // posted as a pull request review.
    const got = splitReasoning("<think>Let me analyze this PR carefully.</think>\n\n## Findings\n\n1. A real one.");
    expect(got.text).toBe("## Findings\n\n1. A real one.");
    expect(got.strippedReasoning).toBe(true);
    expect(got.truncatedInReasoning).toBe(false);
  });

  it("removes the ◁think▷ spelling too", () => {
    const got = splitReasoning("◁think▷hmm◁/think▷answer");
    expect(got.text).toBe("answer");
    expect(got.strippedReasoning).toBe(true);
  });

  it("removes every block, not just the first", () => {
    const got = splitReasoning("<think>a</think>one<think>b</think>two");
    expect(got.text).toBe("onetwo");
  });

  it("reports an unterminated block as truncated rather than as an answer", () => {
    // A completion cut off mid-thought. The answer was never written, which is a
    // different thing from an empty answer and has to be distinguishable.
    const got = splitReasoning("<think>I will start by");
    expect(got.text).toBe("");
    expect(got.truncatedInReasoning).toBe(true);
    expect(got.strippedReasoning).toBe(true);
  });

  it("keeps what came before an unterminated block", () => {
    const got = splitReasoning("partial answer<think>then it stopped");
    expect(got.text).toBe("partial answer");
    expect(got.truncatedInReasoning).toBe(true);
  });

  it("does not treat prose about thinking as a block", () => {
    // Guard: a review that discusses `<think>` in a code fence must survive. The
    // opening tag is only a tag when it is one.
    const got = splitReasoning("The model emits a think tag, spelled `< think >` with spaces.");
    expect(got.strippedReasoning).toBe(false);
  });
});

describe("validateProviderUrl keepPath", () => {
  it("drops the path by default, and keeps it when asked", async () => {
    const { validateProviderUrl } = await import("@/lib/providers/url-validation");
    // The Z.AI case: its API is at /api/paas/v4, and the default shape made it
    // unreachable whatever origin was configured.
    expect(validateProviderUrl("https://api.z.ai/api/paas/v4", { hosted: false })).toBe("https://api.z.ai");
    expect(validateProviderUrl("https://api.z.ai/api/paas/v4", { hosted: false, keepPath: true })).toBe(
      "https://api.z.ai/api/paas/v4",
    );
  });

  it("strips a trailing slash so a caller can append a route", async () => {
    const { validateProviderUrl } = await import("@/lib/providers/url-validation");
    expect(validateProviderUrl("https://api.z.ai/api/paas/v4/", { hosted: false, keepPath: true })).toBe(
      "https://api.z.ai/api/paas/v4",
    );
  });

  it("still refuses a private host when hosted, path or no path", async () => {
    const { validateProviderUrl } = await import("@/lib/providers/url-validation");
    // keepPath must not become a way around the SSRF control.
    expect(() => validateProviderUrl("http://169.254.169.254/latest", { hosted: true, keepPath: true })).toThrow();
  });
});
