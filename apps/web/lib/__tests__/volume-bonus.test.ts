import { describe, it, expect } from "bun:test";
import { volumeBonusUsd } from "../plans";

describe("volumeBonusUsd (promotional tiers)", () => {
  it("gives 50% at $100 — the headline $150-for-$100 deal", () => {
    expect(volumeBonusUsd(100)).toBe(50);
    expect(100 + volumeBonusUsd(100)).toBe(150);
  });

  it("scales up: 60% at $250, 70% at $500 (highest matching tier wins)", () => {
    expect(volumeBonusUsd(250)).toBe(150); // $250 -> $400
    expect(volumeBonusUsd(500)).toBe(350); // $500 -> $850
    expect(volumeBonusUsd(1000)).toBe(700); // caps at the top tier's rate
  });

  it("no bonus below the $100 floor", () => {
    expect(volumeBonusUsd(50)).toBe(0);
    expect(volumeBonusUsd(99)).toBe(0);
  });

  it("guards invalid input", () => {
    expect(volumeBonusUsd(0)).toBe(0);
    expect(volumeBonusUsd(-10)).toBe(0);
    expect(volumeBonusUsd(NaN)).toBe(0);
  });
});
