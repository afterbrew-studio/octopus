import { describe, it, expect } from "bun:test";
import { selectRulePacks, allRules } from "@/lib/rulepacks";

const diffFor = (path: string, changed = 5) => {
  const lines = Array.from({ length: changed }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${changed} @@\n${lines}\n`;
};

describe("selectRulePacks", () => {
  it("a Go-only diff injects go + security, not python/typescript", () => {
    const out = selectRulePacks(diffFor("cmd/main.go"));
    expect(out).toContain("Security rulepack");
    expect(out).toContain("Go rulepack");
    expect(out).not.toContain("Python rulepack");
    expect(out).not.toContain("TypeScript");
  });

  it("always includes the security pack", () => {
    expect(selectRulePacks(diffFor("README.md"))).toContain("Security rulepack");
  });

  it("caps to the top 3 languages by changed-line count", () => {
    const diff =
      diffFor("a.ts", 50) + diffFor("b.py", 40) + diffFor("c.go", 30) +
      diffFor("d.rs", 20) + diffFor("e.rb", 10);
    const out = selectRulePacks(diff);
    // top 3 by changed lines: ts, python, go — not rust/ruby
    expect(out).toContain("TypeScript");
    expect(out).toContain("Python rulepack");
    expect(out).toContain("Go rulepack");
    expect(out).not.toContain("Rust rulepack");
    expect(out).not.toContain("Ruby rulepack");
  });

  it("maps multiple extensions to the same language (tsx→typescript)", () => {
    expect(selectRulePacks(diffFor("src/App.tsx"))).toContain("TypeScript");
  });
});

describe("rulepack rule completeness", () => {
  it("every rule has the required fields", () => {
    for (const r of allRules()) {
      expect(r.id, `id on ${JSON.stringify(r)}`).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.signal).toBeTruthy();
      expect(r.remediation).toBeTruthy();
      expect(r.example).toBeTruthy();
      expect(Array.isArray(r.languages) && r.languages.length > 0).toBe(true);
      expect(["🔴", "🟠", "🟡"]).toContain(r.severityHint);
    }
  });

  it("security rules carry CWE + OWASP taxonomy", () => {
    const sec = allRules().filter((r) => r.id.startsWith("sec-"));
    expect(sec.length).toBeGreaterThan(0);
    for (const r of sec) {
      expect(r.cwe, `cwe on ${r.id}`).toMatch(/^CWE-\d+$/);
      expect(r.owasp, `owasp on ${r.id}`).toBeTruthy();
    }
  });

  it("rule ids are unique", () => {
    const ids = allRules().map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
