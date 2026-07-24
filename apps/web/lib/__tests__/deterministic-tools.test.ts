import { describe, it, expect } from "bun:test";
import {
  parseSemgrepJson,
  formatToolFindings,
  toolPrePassEnabled,
} from "@/lib/deterministic-tools-parse";

const semgrepOut = JSON.stringify({
  results: [
    { path: "/tmp/octo-x/src/a.ts", start: { line: 12 }, check_id: "octo-js-exec-shell", extra: { severity: "ERROR", message: "command injection risk" } },
    { path: "/tmp/octo-x/app.py", start: { line: 3 }, check_id: "octo-py-yaml-load", extra: { severity: "WARNING", message: "unsafe yaml.load" } },
    { path: "bad", start: {} }, // malformed → skipped
  ],
});

describe("toolPrePassEnabled", () => {
  it("is off by default and on only when explicitly enabled", () => {
    expect(toolPrePassEnabled({})).toBe(false);
    expect(toolPrePassEnabled({ enableToolPrePass: false })).toBe(false);
    expect(toolPrePassEnabled({ enableToolPrePass: true })).toBe(true);
  });
});

describe("parseSemgrepJson", () => {
  it("normalizes results and strips the temp-dir prefix", () => {
    const out = parseSemgrepJson(semgrepOut, "/tmp/octo-x/");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ tool: "semgrep", filePath: "src/a.ts", line: 12, severity: "🔴" });
    expect(out[1]).toMatchObject({ filePath: "app.py", severity: "🟠" });
  });
  it("returns [] on malformed JSON", () => {
    expect(parseSemgrepJson("not json")).toEqual([]);
    expect(parseSemgrepJson("{}")).toEqual([]);
  });
});

describe("formatToolFindings", () => {
  it("renders provenance + location, empty when none", () => {
    expect(formatToolFindings([])).toBe("");
    const s = formatToolFindings(parseSemgrepJson(semgrepOut, "/tmp/octo-x/"));
    expect(s).toContain("[semgrep:octo-js-exec-shell] src/a.ts:L12");
    expect(s).toContain("🔴");
  });
});
