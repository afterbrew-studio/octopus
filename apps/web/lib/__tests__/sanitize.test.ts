import { describe, expect, it } from "bun:test";
import { stripLoneSurrogates } from "@/lib/providers/sanitize";

const FFFD = "�";

describe("stripLoneSurrogates", () => {
  it("leaves plain text and valid emoji (surrogate pairs) untouched", () => {
    expect(stripLoneSurrogates("hello world")).toBe("hello world");
    expect(stripLoneSurrogates("done 😀!")).toBe("done 😀!"); // 😀
    expect(stripLoneSurrogates("astral 𐀀 ok")).toBe("astral 𐀀 ok");
  });

  it("replaces a lone HIGH surrogate (the 'no low surrogate' case)", () => {
    expect(stripLoneSurrogates("bad\uD800end")).toBe(`bad${FFFD}end`);
    expect(stripLoneSurrogates("trailing\uD83D")).toBe(`trailing${FFFD}`); // pair split at end
  });

  it("replaces a lone LOW surrogate", () => {
    expect(stripLoneSurrogates("\uDE00leading")).toBe(`${FFFD}leading`); // pair split at start
  });

  it("handles multiple lone surrogates while keeping valid pairs", () => {
    const input = `\uD800a😀b\uDC00`; // lone-high, valid 😀, lone-low
    expect(stripLoneSurrogates(input)).toBe(`${FFFD}a😀b${FFFD}`);
  });

  it("produces a string with no remaining lone surrogates", () => {
    const cleaned = stripLoneSurrogates("x\uD800y\uDC00z😀");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cleaned)).toBe(false);
  });
});
