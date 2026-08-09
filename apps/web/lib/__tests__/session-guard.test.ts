import { beforeEach, describe, expect, it, mock } from "bun:test";

// Locks the ban-enforcement property: a banned user cannot mint a new session
// (the admin ban deletes existing sessions; this guard closes the re-login
// hole that would otherwise leave API routes like /api/chat usable).

type UserRow = { email: string; bannedAt: Date | null } | null;

let userRow: UserRow;
const auditCalls: Array<Record<string, unknown>> = [];

mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({
  prisma: {
    user: { findUnique: mock(() => Promise.resolve(userRow)) },
  },
}));
mock.module("../audit", () => ({
  writeAuditLog: mock((entry: Record<string, unknown>) => {
    auditCalls.push(entry);
    return Promise.resolve();
  }),
}));

// Static imports are hoisted above the mock.module calls, which would evaluate
// session-guard (and its "server-only" / prisma imports) before the mocks are
// registered. A dynamic import after the mocks fixes the ordering.
const { assertUserNotBanned } = await import("../session-guard");
const { APIError } = await import("better-auth/api");

describe("assertUserNotBanned", () => {
  beforeEach(() => {
    userRow = { email: "user@example.com", bannedAt: null };
    auditCalls.length = 0;
  });

  it("allows a non-banned user", async () => {
    await expect(assertUserNotBanned("u1")).resolves.toBeUndefined();
    expect(auditCalls).toHaveLength(0);
  });

  it("throws FORBIDDEN for a banned user and audit-logs the attempt", async () => {
    userRow = { email: "abuser@example.com", bannedAt: new Date() };
    let thrown: unknown;
    try {
      await assertUserNotBanned("u2");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(APIError);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0].action).toBe("auth.login_blocked");
  });

  it("allows when the user row is missing (nothing to enforce)", async () => {
    userRow = null;
    await expect(assertUserNotBanned("ghost")).resolves.toBeUndefined();
  });
});
