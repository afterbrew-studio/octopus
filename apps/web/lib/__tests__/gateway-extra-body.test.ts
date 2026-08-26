import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));
mock.module("openai", () => ({ default: class {} }));

const { parseExtraBody } = await import("@/lib/providers/openai-gateway");

/**
 * Vendor extensions are operator-supplied JSON. They may add to a request and
 * must not redefine what is being asked -- a stray `messages` would review
 * something else, a stray `model` would bill a different one.
 */

describe("parseExtraBody", () => {
  it("returns undefined for absent or blank configuration", () => {
    expect(parseExtraBody(undefined, "X")).toBeUndefined();
    expect(parseExtraBody("", "X")).toBeUndefined();
    expect(parseExtraBody("   ", "X")).toBeUndefined();
  });

  it("parses the case this exists for", () => {
    // MiniMax reasons until the budget is gone unless told not to.
    expect(parseExtraBody('{"thinking":{"type":"disabled"}}', "ACP_EXTRA_BODY")).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it("names the variable when the JSON is bad, rather than dropping it", () => {
    expect(() => parseExtraBody("{not json", "ACP_EXTRA_BODY")).toThrow(/ACP_EXTRA_BODY is not valid JSON/);
  });

  it("refuses a non-object", () => {
    expect(() => parseExtraBody("[1,2]", "ACP_EXTRA_BODY")).toThrow(/must be a JSON object, got an array/);
    expect(() => parseExtraBody('"hello"', "ACP_EXTRA_BODY")).toThrow(/must be a JSON object, got string/);
  });

  it("refuses every reserved key by name", () => {
    for (const key of ["model", "messages", "max_tokens", "max_completion_tokens", "response_format", "stream"]) {
      expect(() => parseExtraBody(`{"${key}":"x"}`, "ACP_EXTRA_BODY")).toThrow(
        new RegExp(`may not set "${key}"`),
      );
    }
  });

  it("refuses a reserved key even alongside a legitimate one", () => {
    // Guard: the check must scan every key, not just the first.
    expect(() => parseExtraBody('{"thinking":{"type":"disabled"},"model":"other"}', "ACP_EXTRA_BODY")).toThrow(
      /may not set "model"/,
    );
  });
});
