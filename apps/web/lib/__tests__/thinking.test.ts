import { describe, expect, it } from "bun:test";
import {
  resolveThinking,
  resolveEffort,
  ALWAYS_THINKING_MAX_TOKENS_FLOOR,
  DEFAULT_THINKING_EFFORT,
} from "@/lib/providers/thinking";

const FLOOR = ALWAYS_THINKING_MAX_TOKENS_FLOOR;

describe("resolveThinking", () => {
  it("non-thinking models get the max_tokens floor but NO thinking/output config", () => {
    const r = resolveThinking("claude-sonnet-4-6", 8192, false);
    expect(r.maxTokens).toBe(FLOOR); // floor applies to all models now
    expect(r.thinking).toBeUndefined();
    expect(r.outputConfig).toBeUndefined();
  });

  it("Fable text path: floor + adaptive thinking + effort", () => {
    const r = resolveThinking("claude-fable-5", 8192, false);
    expect(r.maxTokens).toBe(FLOOR);
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.outputConfig).toEqual({ effort: DEFAULT_THINKING_EFFORT });
  });

  it("Opus 5 text path: also gets adaptive thinking (same Claude-5 thinking API)", () => {
    const r = resolveThinking("claude-opus-5", 8192, false);
    expect(r.maxTokens).toBe(FLOOR);
    expect(r.thinking).toEqual({ type: "adaptive" });
    expect(r.outputConfig).toEqual({ effort: DEFAULT_THINKING_EFFORT });
  });

  it("always-thinking tool path: floor only, no thinking/output config", () => {
    const r = resolveThinking("claude-opus-5", 8192, true);
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
    expect(resolveEffort()).toBe(DEFAULT_THINKING_EFFORT);
    delete process.env.FABLE_THINKING_EFFORT;
  });
});
