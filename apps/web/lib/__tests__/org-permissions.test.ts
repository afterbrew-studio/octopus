import { describe, expect, it } from "bun:test";
import {
  ALL_ORG_SCOPES,
  ORG_SCOPE_LABELS,
  ROLE_BASELINE,
  hasOrgPermission,
  normalizeOrgScopes,
} from "../org-permissions";

describe("hasOrgPermission", () => {
  it("owner and admin baselines cover every scope (rollout is behavior-identical)", () => {
    for (const scope of ALL_ORG_SCOPES) {
      expect(hasOrgPermission({ role: "owner", scopes: [] }, scope)).toBe(true);
      expect(hasOrgPermission({ role: "admin", scopes: [] }, scope)).toBe(true);
    }
  });

  it("member baseline denies every scope", () => {
    for (const scope of ALL_ORG_SCOPES) {
      expect(hasOrgPermission({ role: "member", scopes: [] }, scope)).toBe(false);
    }
  });

  it("an explicit grant adds exactly that scope for a member", () => {
    const m = { role: "member", scopes: ["repos:manage"] };
    expect(hasOrgPermission(m, "repos:manage")).toBe(true);
    expect(hasOrgPermission(m, "billing:manage")).toBe(false);
  });

  it("denies null/undefined member and unknown roles", () => {
    expect(hasOrgPermission(null, "repos:manage")).toBe(false);
    expect(hasOrgPermission(undefined, "repos:manage")).toBe(false);
    expect(hasOrgPermission({ role: "ghost", scopes: [] }, "repos:manage")).toBe(false);
  });

  it("tolerates missing scopes array (rows predating the column default)", () => {
    expect(hasOrgPermission({ role: "member" }, "repos:manage")).toBe(false);
    expect(hasOrgPermission({ role: "member", scopes: null }, "repos:manage")).toBe(false);
  });
});

describe("normalizeOrgScopes", () => {
  it("trims, lowercases, dedupes", () => {
    expect(normalizeOrgScopes([" Repos:Manage ", "repos:manage"])).toEqual(["repos:manage"]);
  });

  it("accepts an empty list (baseline-only member)", () => {
    expect(normalizeOrgScopes([])).toEqual([]);
  });

  it("rejects unknown scopes and non-arrays", () => {
    expect(() => normalizeOrgScopes(["blog:read"])).toThrow(/unknown scope/);
    expect(() => normalizeOrgScopes("repos:manage")).toThrow(/array/);
  });
});

describe("registry consistency", () => {
  it("every scope has a label and appears in a role baseline map", () => {
    for (const scope of ALL_ORG_SCOPES) {
      expect(ORG_SCOPE_LABELS[scope]).toBeTruthy();
    }
    expect(ROLE_BASELINE.owner).toEqual(ALL_ORG_SCOPES);
    expect(ROLE_BASELINE.member).toEqual([]);
  });
});
