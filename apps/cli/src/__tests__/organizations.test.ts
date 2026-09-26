import { describe, expect, it } from "bun:test";
import { chooseOrganization, resolveOrganization, type OrganizationChoice } from "../lib/organizations.js";

const a: OrganizationChoice = { id: "org-a", slug: "alpha", name: "Alpha", hasInstallation: true };
const b: OrganizationChoice = { id: "org-b", slug: "beta", name: "Beta", hasInstallation: true };

describe("command organisation selection", () => {
  it("prefers an explicit slug or ID over repository matches", () => {
    expect(chooseOrganization([a, { ...b, matchesRepository: true }], "alpha", "beta/app")).toEqual(a);
    expect(chooseOrganization([a, b], "org-b")).toEqual(b);
    expect(chooseOrganization([a, b], "missing")).toBeUndefined();
  });
  it("prefers an exact repository over an owner match", () => {
    const exact = { ...b, matchesRepository: true };
    expect(chooseOrganization([{ ...a, matchesOwner: true }, exact], undefined, "beta/app")).toEqual(exact);
  });
  it("never guesses between duplicate repositories or owners", () => {
    expect(chooseOrganization([a, b].map((org) => ({ ...org, matchesRepository: true })))).toBeUndefined();
    expect(chooseOrganization([a, b].map((org) => ({ ...org, matchesOwner: true })))).toBeUndefined();
    expect(chooseOrganization([a, b])).toBeUndefined();
  });
  it("allows first installation but does not infer an unrelated installed org", () => {
    expect(chooseOrganization([a], undefined, "unknown/app")).toBeUndefined();
    expect(chooseOrganization([{ ...a, hasInstallation: false }], undefined, "unknown/app")?.id).toBe(a.id);
    expect(chooseOrganization([a])?.id).toBe(a.id);
  });
  it("requires repository evidence for an explicit target even with one membership", () => {
    expect(chooseOrganization([a], undefined, undefined, true)).toBeUndefined();
    expect(chooseOrganization([{ ...a, hasInstallation: false }], undefined, "unknown/app", true)).toBeUndefined();
    expect(chooseOrganization([a], "alpha", undefined, true)).toEqual(a);
    const exact = { ...b, matchesRepository: true };
    expect(chooseOrganization([a, exact], undefined, "beta/app", true)).toEqual(exact);
  });
  it("keeps legacy tokens scoped and requires login before switching", async () => {
    const credentials = { baseUrl: "https://example.com", token: "legacy", orgId: a.id, orgSlug: a.slug, orgName: a.name, approvedAt: "2026-09-12" };
    expect(await resolveOrganization(credentials, a.slug)).toEqual({ ok: true, credentials, userSession: false });
    expect(await resolveOrganization(credentials, b.slug)).toMatchObject({ ok: false, state: "authentication_required" });
  });
});
