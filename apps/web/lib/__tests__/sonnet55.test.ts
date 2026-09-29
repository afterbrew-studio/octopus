import { describe, expect, it } from "bun:test";
import { prepareAnthropicRequest, usesNativeJsonOutput } from "../providers/anthropic-request";
import { ALWAYS_THINKING_MODEL_RX } from "../providers/thinking";

describe("Sonnet 5.5 requests", () => {
  const base = { model: "claude-sonnet-5-5", maxTokens: 1000, messages: [{ role: "user" as const, content: "Review this change" }] };
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

  it("uses adaptive thinking and the Octopus medium default when thinking is omitted", () => {
    const previous = process.env.FABLE_THINKING_EFFORT;
    delete process.env.FABLE_THINKING_EFFORT;
    try {
      const body = prepareAnthropicRequest(base, "5m");
      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "medium" });
      expect(body.max_tokens).toBe(64000);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.FABLE_THINKING_EFFORT;
      else process.env.FABLE_THINKING_EFFORT = previous;
    }
  });

  it("uses native JSON instead of unsupported forced tools", () => {
    const body = prepareAnthropicRequest({ ...base, effort: "medium", responseSchema: { name: "result", schema } }, "5m");
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "medium", format: { type: "json_schema", schema } });
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("maps explicit thinking-off to between_tools and limits only that mode's effort", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const body = prepareAnthropicRequest({ ...base, effort, thinking: "disabled", responseSchema: { name: "result", schema } }, "5m");
      expect(body.thinking).toEqual({ type: "between_tools" });
      expect(body.output_config).toEqual({ effort: effort === "xhigh" || effort === "max" ? "high" : effort, format: { type: "json_schema", schema } });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(prepareAnthropicRequest({ ...base, effort }, "5m").output_config).toEqual({ effort });
    }
  });

  it("also limits an environment effort override when thinking is explicitly disabled", () => {
    const previous = process.env.FABLE_THINKING_EFFORT;
    process.env.FABLE_THINKING_EFFORT = "max";
    try {
      const body = prepareAnthropicRequest({ ...base, thinking: "disabled" }, "5m");
      expect(body.thinking).toEqual({ type: "between_tools" });
      expect(body.output_config).toEqual({ effort: "high" });
    } finally {
      if (previous === undefined) delete process.env.FABLE_THINKING_EFFORT;
      else process.env.FABLE_THINKING_EFFORT = previous;
    }
  });

  it("matches only the exact Sonnet 5.5 model and preserves earlier models", () => {
    expect(ALWAYS_THINKING_MODEL_RX.test(base.model)).toBe(true);
    expect(usesNativeJsonOutput(base.model)).toBe(true);
    for (const model of ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-5-50", "claude-sonnet-5-5-20260929"]) {
      expect(ALWAYS_THINKING_MODEL_RX.test(model)).toBe(false);
      expect(usesNativeJsonOutput(model)).toBe(false);
      const body = prepareAnthropicRequest({ ...base, model, thinking: "disabled", effort: "max", responseSchema: { name: "result", schema } }, "5m");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body.max_tokens).toBe(1000);
      expect(body.output_config).toBeUndefined();
      expect(body.tool_choice).toEqual({ type: "tool", name: "result" });
    }
    const opus = prepareAnthropicRequest({ ...base, model: "claude-opus-5-5", thinking: "disabled", effort: "max" }, "5m");
    expect(opus.thinking).toEqual({ type: "adaptive" });
    expect(opus.output_config).toEqual({ effort: "max" });
  });
});
