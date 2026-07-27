import { describe, expect, it } from "bun:test";
import {
  resolveThinking,
  resolveEffort,
  ALWAYS_THINKING_MAX_TOKENS_FLOOR,
  DEFAULT_THINKING_EFFORT,
} from "@/lib/providers/thinking";

const FLOOR = ALWAYS_THINKING_MAX_TOKENS_FLOOR;

describe("resolveThinking", () => {
  it("leaves non-thinking models untouched (no thinking/output config)", () => {
    const r = resolveThinking("claude-sonnet-4-6", 8192, false);
    expect(r.maxTokens).toBe(8192);
    expect(r.thinking).toBeUndefined();
    expect(r.outputConfig).toBeUndefined();
  });

  it("text path: raises to the floor and sets ADAPTIVE thinking + effort", () => {
    const r = resolveThinking("claude-fable-5", 8192, false);
    expect(r.maxTokens).toBe(FLOOR);
    // Must be adaptive — these models reject thinking.type.enabled.
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.outputConfig).toEqual({ effort: DEFAULT_THINKING_EFFORT });
  });

  it("tool path: floor only, no thinking/output config (avoid tool_choice conflict)", () => {
    const r = resolveThinking("claude-fable-5", 8192, true);
    expect(r.maxTokens).toBe(FLOOR);
    expect(r.thinking).toBeUndefined();
    expect(r.outputConfig).toBeUndefined();
  });

  it("honors a caller max_tokens above the floor", () => {
    const r = resolveThinking("claude-mythos-1", 100000, false);
    expect(r.maxTokens).toBe(100000);
    expect(r.thinking).toEqual({ type: "adaptive" });
  });
});

describe("resolveEffort", () => {
  it("defaults to a valid effort and accepts env overrides", () => {
    delete process.env.FABLE_THINKING_EFFORT;
    expect(resolveEffort()).toBe(DEFAULT_THINKING_EFFORT);
    process.env.FABLE_THINKING_EFFORT = "medium";
    expect(resolveEffort()).toBe("medium");
    process.env.FABLE_THINKING_EFFORT = "bogus";
    expect(resolveEffort()).toBe(DEFAULT_THINKING_EFFORT); // invalid → default
    delete process.env.FABLE_THINKING_EFFORT;
  });
});
