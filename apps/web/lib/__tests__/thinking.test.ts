import { describe, expect, it } from "bun:test";
import {
  resolveThinking,
  ALWAYS_THINKING_MAX_TOKENS_FLOOR,
  ALWAYS_THINKING_OUTPUT_HEADROOM,
} from "@/lib/providers/thinking";

const FLOOR = ALWAYS_THINKING_MAX_TOKENS_FLOOR;
const HEADROOM = ALWAYS_THINKING_OUTPUT_HEADROOM;

describe("resolveThinking", () => {
  it("leaves non-thinking models untouched (no thinking, max_tokens as requested)", () => {
    const r = resolveThinking("claude-sonnet-4-6", 8192, false);
    expect(r.maxTokens).toBe(8192);
    expect(r.thinking).toBeUndefined();
  });

  it("text path: raises to the floor and caps thinking to reserve output headroom", () => {
    const r = resolveThinking("claude-fable-5", 8192, false);
    expect(r.maxTokens).toBe(FLOOR);
    expect(r.thinking).toEqual({ type: "enabled", budget_tokens: FLOOR - HEADROOM });
    // The whole point: output room is always reserved, budget is a valid cap.
    expect(r.maxTokens - r.thinking!.budget_tokens).toBe(HEADROOM);
    expect(r.thinking!.budget_tokens).toBeGreaterThanOrEqual(1024);
    expect(r.thinking!.budget_tokens).toBeLessThan(r.maxTokens);
  });

  it("tool path: raises to the floor but sets NO thinking (forced tool_choice conflict)", () => {
    const r = resolveThinking("claude-fable-5", 8192, true);
    expect(r.maxTokens).toBe(FLOOR);
    expect(r.thinking).toBeUndefined();
  });

  it("honors a caller max_tokens above the floor and scales the budget with it", () => {
    const r = resolveThinking("claude-mythos-1", 100000, false);
    expect(r.maxTokens).toBe(100000);
    expect(r.thinking!.budget_tokens).toBe(100000 - HEADROOM);
    expect(r.maxTokens - r.thinking!.budget_tokens).toBe(HEADROOM);
  });
});
