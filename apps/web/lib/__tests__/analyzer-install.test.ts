import { describe, expect, it } from "bun:test";
import { resolveAnalyzerInstallation } from "@/lib/analyzer-install";

function client(
  repo: { installationId: number | null; organizationId: string } | null,
  isMember: boolean,
) {
  return {
    repository: {
      findUnique: () => Promise.resolve(repo),
    },
    organizationMember: {
      findFirst: () => Promise.resolve(isMember ? { id: "m1" } : null),
    },
  };
}

describe("resolveAnalyzerInstallation", () => {
  it("no repositoryId → returns the fallback (current-org) installation", async () => {
    const got = await resolveAnalyzerInstallation(client(null, false), {
      repositoryId: null,
      callerOrgId: "org1",
      callerUserId: "u1",
      fallbackInstallationId: 42,
    });
    expect(got).toBe(42);
  });

  it("repo in caller's current org → uses the repo's own installation", async () => {
    const got = await resolveAnalyzerInstallation(
      client({ installationId: 111609667, organizationId: "org1" }, false),
      { repositoryId: "r1", callerOrgId: "org1", callerUserId: "u1", fallbackInstallationId: null },
    );
    expect(got).toBe(111609667); // fixes null/stale org column
  });

  it("repo in another org the caller is a MEMBER of → still uses repo installation", async () => {
    const got = await resolveAnalyzerInstallation(
      client({ installationId: 999, organizationId: "org2" }, true),
      { repositoryId: "r1", callerOrgId: "org1", callerUserId: "u1", fallbackInstallationId: 7 },
    );
    expect(got).toBe(999);
  });

  it("repo in an org the caller does NOT belong to → refuses, keeps fallback (tenancy)", async () => {
    const got = await resolveAnalyzerInstallation(
      client({ installationId: 999, organizationId: "org2" }, false),
      { repositoryId: "r1", callerOrgId: "org1", callerUserId: "u1", fallbackInstallationId: 7 },
    );
    expect(got).toBe(7); // does NOT leak org2's installation
  });

  it("unknown repositoryId → fallback", async () => {
    const got = await resolveAnalyzerInstallation(client(null, true), {
      repositoryId: "missing",
      callerOrgId: "org1",
      callerUserId: "u1",
      fallbackInstallationId: 5,
    });
    expect(got).toBe(5);
  });

  it("repo authorized but its own installationId is null → fallback", async () => {
    const got = await resolveAnalyzerInstallation(
      client({ installationId: null, organizationId: "org1" }, false),
      { repositoryId: "r1", callerOrgId: "org1", callerUserId: "u1", fallbackInstallationId: 8 },
    );
    expect(got).toBe(8);
  });
});
