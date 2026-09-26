import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";

const enabled = process.env.RUN_CLI_AUTH_DB_TESTS === "1";
if (enabled && !/(^|[-_])test($|[-_])/.test(new URL(process.env.DATABASE_URL ?? "http://invalid").pathname.slice(1))) throw new Error("CLI auth tests require a dedicated test database");
const fixture = randomUUID().replaceAll("-", "");
const userId = `cli_test_${fixture}`;
const orgIds = [0, 1, 2].map((n) => `cli_test_${fixture}_${n}`);
let held = false;
if (enabled) {
  mock.module("server-only", () => ({}));
  mock.module("next/headers", () => ({ headers: async () => new Headers() }));
  mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: userId, name: "CLI Test", email: `${userId}@example.test` } }) } } }));
  mock.module("@/lib/account-standing", () => ({ getAccountStanding: async () => ({ held }), ACCOUNT_HOLD_MESSAGE: "Account held", isHeldRiskBand: () => false, orgHasProductSignal: async () => true }));
}
let prisma: (typeof import("@octopus/db"))["prisma"];
let userAuth: typeof import("@/lib/cli-user-auth");
let apiAuth: typeof import("@/lib/api-auth");
let organizations: typeof import("@/app/api/cli/organizations/route");
let approval: typeof import("@/app/api/cli/auth/approve/route");
let deviceRoute: typeof import("@/app/api/cli/auth/device/route");
let poll: typeof import("@/app/api/cli/auth/poll/route");
let userRoute: typeof import("@/app/api/cli/auth/user/route");
if (enabled) {
  ({ prisma } = await import("@octopus/db"));
  userAuth = await import("@/lib/cli-user-auth");
  apiAuth = await import("@/lib/api-auth");
  organizations = await import("@/app/api/cli/organizations/route");
  approval = await import("@/app/api/cli/auth/approve/route");
  deviceRoute = await import("@/app/api/cli/auth/device/route");
  poll = await import("@/app/api/cli/auth/poll/route");
  userRoute = await import("@/app/api/cli/auth/user/route");
}
function request(path: string, token?: string, body?: unknown, origin = "http://localhost") {
  return new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function session() {
  const raw = userAuth.generateCliUserToken();
  const row = await prisma.cliUserToken.create({ data: { userId, tokenHash: userAuth.hashCliToken(raw), expiresAt: new Date(Date.now() + 60_000) } });
  return { raw, row };
}
async function exchange(raw: string, org = orgIds[0]) {
  return organizations.POST(request("/api/cli/organizations", raw, { organization: org }));
}
const suite = enabled ? describe : describe.skip;
suite("CLI user sessions with PostgreSQL", () => {
  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, name: "CLI Test", email: `${userId}@example.test` } });
    for (const id of orgIds) await prisma.organization.create({ data: { id, slug: id, name: id } });
    for (const organizationId of orgIds.slice(0, 2)) await prisma.organizationMember.create({ data: { userId, organizationId, role: "member" } });
  });
  afterAll(async () => {
    await prisma.cliAuthSession.deleteMany({ where: { userEmail: `${userId}@example.test` } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });
  it("retains empty-body and empty-object legacy device requests while accepting user scope", async () => {
    for (const body of [undefined, {}, { scope: "user" }]) {
      const response = await deviceRoute.POST(new Request("http://localhost/api/cli/auth/device", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.scope).toBe(body && "scope" in body ? "user" : "organization");
      await prisma.cliAuthSession.delete({ where: { deviceCode: data.deviceCode } });
    }
    expect((await deviceRoute.POST(request("/api/cli/auth/device", undefined, { scope: "admin" }))).status).toBe(400);
  });
  it("lists only current memberships, exchanges each scope once, and never accepts user credentials as org tokens", async () => {
    const { raw, row } = await session();
    const list = await organizations.GET(request("/api/cli/organizations", raw));
    expect(list.status).toBe(200);
    expect((await list.json()).organizations.map((org: { id: string }) => org.id)).toEqual(orgIds.slice(0, 2));
    expect(await apiAuth.authenticateApiToken(request("/api/cli/me", raw))).toBeNull();
    expect((await exchange(raw, orgIds[2])).status).toBe(403);
    const first = await (await exchange(raw)).json();
    const again = await (await exchange(raw)).json();
    const second = await (await exchange(raw, orgIds[1])).json();
    expect(first.token).toBe(again.token);
    expect(second.token).not.toBe(first.token);
    expect(await prisma.orgApiToken.count({ where: { cliUserTokenId: row.id } })).toBe(2);
    const auth = await apiAuth.authenticateApiToken(request("/api/cli/me", first.token));
    expect(auth && !(auth instanceof Response) && auth.org.id).toBe(orgIds[0]);
    held = true;
    expect((await exchange(raw)).status).toBe(403);
    held = false;
  });
  it("rejects removed membership, banned users, revoked children and revoked/expired parents", async () => {
    const { raw, row } = await session();
    const { token } = await (await exchange(raw)).json();
    const check = () => apiAuth.authenticateApiToken(request("/api/cli/me", token));
    await prisma.organizationMember.updateMany({ where: { userId, organizationId: orgIds[0] }, data: { deletedAt: new Date() } });
    expect(await check()).toBeNull();
    expect((await exchange(raw)).status).toBe(403);
    await prisma.organizationMember.updateMany({ where: { userId, organizationId: orgIds[0] }, data: { deletedAt: null } });
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: new Date() } });
    expect(await check()).toBeNull();
    expect((await exchange(raw)).status).toBe(401);
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: null } });
    await prisma.cliUserToken.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
    expect(await check()).toBeNull();
    await prisma.cliUserToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.orgApiToken.updateMany({ where: { cliUserTokenId: row.id }, data: { deletedAt: new Date() } });
    expect((await exchange(raw)).status).toBe(403);
    expect(await check()).toBeNull();
    const other = await (await exchange(raw, orgIds[1])).json();
    expect((await userRoute.DELETE(request("/api/cli/auth/user", raw))).status).toBe(200);
    expect(await apiAuth.authenticateApiToken(request("/api/cli/me", other.token))).toBeNull();
    expect((await exchange(raw)).status).toBe(401);
  });
  it("revokes by possession during a ban or after expiry without restoring access", async () => {
    for (const state of ["banned", "expired"]) {
      const { raw, row } = await session();
      const { token } = await (await exchange(raw)).json();
      try {
        if (state === "banned") await prisma.user.update({ where: { id: userId }, data: { bannedAt: new Date() } });
        else await prisma.cliUserToken.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } });
        expect((await userRoute.GET(request("/api/cli/auth/user", raw))).status).toBe(401);
        expect((await exchange(raw)).status).toBe(401);
        expect((await userRoute.DELETE(request("/api/cli/auth/user", raw))).status).toBe(200);
        expect((await prisma.cliUserToken.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).not.toBeNull();
      } finally {
        await prisma.user.update({ where: { id: userId }, data: { bannedAt: null } });
      }
      expect((await userRoute.GET(request("/api/cli/auth/user", raw))).status).toBe(401);
      expect((await exchange(raw)).status).toBe(401);
      expect(await apiAuth.authenticateApiToken(request("/api/cli/me", token))).toBeNull();
      expect((await userRoute.DELETE(request("/api/cli/auth/user", raw))).status).toBe(200);
    }
    for (const raw of [undefined, "oct_invalid", userAuth.generateCliUserToken()]) {
      expect((await userRoute.DELETE(request("/api/cli/auth/user", raw))).status).toBe(401);
    }
  });
  it("keeps legacy approvals organisation-scoped and refuses expired approval", async () => {
    const deviceCode = randomUUID().replaceAll("-", "") + "87654321";
    const device = await prisma.cliAuthSession.create({ data: { deviceCode, expiresAt: new Date(Date.now() + 60_000), userEmail: `${userId}@example.test` } });
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode }))).status).toBe(400);
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode, organizationId: orgIds[2] }))).status).toBe(403);
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode, organizationId: orgIds[0] }))).status).toBe(200);
    const granted = await (await poll.GET(new NextRequest(`http://localhost/api/cli/auth/poll?device_code=${deviceCode}`))).json();
    expect(granted).toMatchObject({ scope: "organization", organization: { id: orgIds[0] } });
    const legacy = await apiAuth.authenticateApiToken(request("/api/cli/me", granted.token));
    expect(legacy && !(legacy instanceof Response) && legacy.token.cliUserTokenId).toBeNull();
    await prisma.cliAuthSession.update({ where: { id: device.id }, data: { status: "pending", expiresAt: new Date(0) } });
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode, organizationId: orgIds[0] }))).status).toBe(410);
  });
  it("approves without an org, rejects tampering/CSRF, and mints and polls only once under concurrency", async () => {
    const deviceCode = randomUUID().replaceAll("-", "") + "12345678";
    const device = await prisma.cliAuthSession.create({ data: { deviceCode, scope: "user", expiresAt: new Date(Date.now() + 60_000), userEmail: `${userId}@example.test` } });
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode }, "https://evil.test"))).status).toBe(403);
    expect((await approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode, organizationId: orgIds[0] }))).status).toBe(400);
    const before = await prisma.cliUserToken.count({ where: { userId } });
    const results = await Promise.all([0, 1].map(() => approval.POST(request("/api/cli/auth/approve", undefined, { deviceCode }))));
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(await prisma.cliUserToken.count({ where: { userId } })).toBe(before + 1);
    const approved = await prisma.cliAuthSession.findUniqueOrThrow({ where: { id: device.id } });
    expect(approved.orgId).toBeNull();
    const responses = await Promise.all([0, 1].map(() => poll.GET(new NextRequest(`http://localhost/api/cli/auth/poll?device_code=${deviceCode}`))));
    const bodies = await Promise.all(responses.map((response) => response.json()));
    const grants = bodies.filter((body) => body.token);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ scope: "user", organization: null });
    expect(grants[0].token).toMatch(/^oct_u_[a-f0-9]{64}$/);
    expect((await prisma.cliAuthSession.findUniqueOrThrow({ where: { id: device.id } })).token).toBeNull();
  });
});
