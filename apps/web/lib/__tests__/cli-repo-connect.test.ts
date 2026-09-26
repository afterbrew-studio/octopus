import { describe, expect, it, mock } from "bun:test";
mock.module("server-only", () => ({}));
import type { ConnectRepositoryServices } from "../cli-repo-connect";
const { connectCliRepository, parseConnectRepository } = await import("../cli-repo-connect");
const input = { fullName: "acme/app", organizationId: "org-1", installationId: 42 as number | null, baseUrl: "https://octopus-review.ai" };
const repo = { id: "repo-1", isActive: true, dismissedAt: null as Date | null, installationId: 42 };
function fixture() {
  const calls: string[] = [];
  const services: ConnectRepositoryServices = {
    find: async () => repo,
    appConfigured: async () => true,
    settingsUrl: async (id) => { calls.push(`settings:${id}`); return `https://github.com/organizations/acme/settings/installations/${id}`; },
    list: async (id) => { calls.push(`list:${id}`); return [{ id: 1, name: "app", full_name: "acme/app", default_branch: "main" }]; },
    sync: async (id) => { calls.push(`sync:${id}`); },
  };
  return { services, calls };
}
describe("CLI repository connection", () => {
  it("rejects unscoped and malformed requests", () => {
    for (const value of [null, [], {}, { fullName: "app" }, { fullName: "acme/.." }, { fullName: "acme/app", organizationId: "other" }, { fullName: "acme/app\n" }]) expect(parseConnectRepository(value)).toBeNull();
    expect(parseConnectRepository({ fullName: "acme/app" })).toBe("acme/app");
  });
  it("reuses a connected target without another installation", async () => {
    const f = fixture();
    expect(await connectCliRepository(input, f.services)).toEqual({ state: "connected", repoId: "repo-1" });
    expect(f.calls).toEqual([]);
  });
  it("returns the signed install-start route with the token organisation", async () => {
    const f = fixture();
    f.services.find = async () => null;
    const result = await connectCliRepository({ ...input, installationId: null }, f.services);
    expect(result.state).toBe("installation_required");
    expect("url" in result && new URL(result.url).searchParams.get("orgId")).toBe("org-1");
    expect(f.calls).toEqual([]);
  });
  it("returns access settings for the existing bound installation", async () => {
    const f = fixture();
    f.services.find = async () => null;
    f.services.list = async () => [];
    expect((await connectCliRepository(input, f.services)).state).toBe("repository_access_required");
    expect(f.calls).toEqual(["settings:42"]);
  });
  it("imports only the target proven accessible through that installation", async () => {
    const f = fixture(); let imported = false;
    f.services.find = async () => imported ? repo : null;
    f.services.sync = async (id, ghRepo) => { expect(id).toBe(42); expect(ghRepo.full_name).toBe("acme/app"); imported = true; };
    expect((await connectCliRepository(input, f.services)).state).toBe("connected");
    expect(f.calls).toEqual(["list:42"]);
  });
  it("does not restore a dismissed repository or confuse another installation", async () => {
    const f = fixture();
    f.services.find = async () => ({ ...repo, dismissedAt: new Date() });
    expect((await connectCliRepository(input, f.services)).state).toBe("repository_dismissed");
    expect(f.calls).toEqual([]);
    f.services.find = async () => ({ ...repo, installationId: 99 });
    f.services.list = async () => [];
    expect((await connectCliRepository(input, f.services)).state).toBe("repository_access_required");
  });
  it("does not report a failed import as connected", async () => {
    const f = fixture(); f.services.find = async () => null;
    await expect(connectCliRepository(input, f.services)).rejects.toThrow("sync_incomplete");
    f.services.list = async () => { throw new Error("unavailable"); };
    await expect(connectCliRepository(input, f.services)).rejects.toThrow("unavailable");
  });
});
