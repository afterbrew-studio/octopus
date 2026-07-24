import { describe, it, expect } from "bun:test";
import { splitSystemForCache, CACHE_BREAKPOINT } from "@/lib/providers/system-cache";

describe("splitSystemForCache (#650)", () => {
  const sys = `INSTRUCTIONS + RULEPACKS${CACHE_BREAKPOINT}VOLATILE CONTEXT`;

  it("splits into a cached prefix + uncached suffix when caching + marker present", () => {
    const blocks = splitSystemForCache(sys, true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe("INSTRUCTIONS + RULEPACKS");
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].text).toBe("VOLATILE CONTEXT");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("never emits the marker text in any block", () => {
    for (const b of splitSystemForCache(sys, true)) {
      expect(b.text.includes(CACHE_BREAKPOINT)).toBe(false);
    }
  });

  it("without caching, strips the marker into a single uncached block", () => {
    const blocks = splitSystemForCache(sys, false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[0].text.includes(CACHE_BREAKPOINT)).toBe(false);
    expect(blocks[0].text).toBe("INSTRUCTIONS + RULEPACKSVOLATILE CONTEXT");
  });

  it("no marker + caching → single cached block", () => {
    const blocks = splitSystemForCache("plain system", true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("drops an empty suffix", () => {
    const blocks = splitSystemForCache(`prefix${CACHE_BREAKPOINT}   `, true);
    expect(blocks).toHaveLength(1);
  });
});

describe("splitSystemForCache empty-side guards (#650)", () => {
  it("never emits an empty prefix block (marker at start → single suffix block)", () => {
    const blocks = splitSystemForCache(`${CACHE_BREAKPOINT}only volatile`, true);
    expect(blocks.every((b) => b.text.trim().length > 0)).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("only volatile");
  });
  it("never emits an empty suffix block (marker at end → single cached block)", () => {
    const blocks = splitSystemForCache(`only static${CACHE_BREAKPOINT}`, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
  });
});
