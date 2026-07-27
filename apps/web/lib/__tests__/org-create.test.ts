import { beforeEach, describe, expect, it, mock } from "bun:test";

// Integration-ish test of the welcome-bonus gate in createOrgForUser, with
// @octopus/db mocked (same approach as billing.test.ts). Locks the security
// property that a WITHHELD first org still consumes the one-time bonus (stamps
// welcomeGrantedAt), and that delete-recreate / already-granted don't re-grant.

type UserRow = {
  emailVerified: boolean;
  signupIp: string | null;
  welcomeGrantedAt: Date | null;
};

let userRow: UserRow;
let ipPeerCount: number;
let everOwnedCount: number; // hasEverOwnedOrg (no deletedAt filter)
let activeOwnedCount: number; // cap check (deletedAt: null)
let claimCount: number; // updateMany result count
let createdData: Record<string, unknown> | null;
let claimCalled: boolean;

const orgMemberCount = mock((args: { where?: Record<string, unknown> }) => {
  const w = args?.where ?? {};
  // The active-owner counts filter on deletedAt; hasEverOwnedOrg does not.
  return Promise.resolve("deletedAt" in w ? activeOwnedCount : everOwnedCount);
});
const userUpdateMany = mock(() => {
  claimCalled = true;
  return Promise.resolve({ count: claimCount });
});
const orgCreate = mock((args: { data: Record<string, unknown> }) => {
  createdData = args.data;
  return Promise.resolve({ id: "org1", ...args.data });
});

const client = {
  organizationMember: { count: orgMemberCount },
  user: {
    findUnique: mock(() => Promise.resolve(userRow)),
    count: mock(() => Promise.resolve(ipPeerCount)),
    update: mock(() => Promise.resolve({})),
    updateMany: userUpdateMany,
  },
  organization: {
    findUnique: mock(() => Promise.resolve(null)), // slug is unique on first try
    create: orgCreate,
  },
  $transaction: (fn: (tx: typeof client) => unknown) => fn(client),
};

mock.module("@octopus/db", () => ({ prisma: client }));

const { createOrgForUser } = await import("@/lib/org-create");
const { WELCOME_FREE_CREDITS } = await import("@/lib/constants");

beforeEach(() => {
  userRow = { emailVerified: true, signupIp: null, welcomeGrantedAt: null };
  ipPeerCount = 0;
  everOwnedCount = 0;
  activeOwnedCount = 0;
  claimCount = 1;
  createdData = null;
  claimCalled = false;
});

describe("createOrgForUser welcome-bonus gate", () => {
  it("clean first org: grants credits and claims the bonus", async () => {
    await createOrgForUser("u1", "Test User");
    expect(claimCalled).toBe(true);
    expect(createdData?.freeCreditBalance).toBe(WELCOME_FREE_CREDITS);
    expect(createdData?.creditTransactions).toBeDefined();
  });

  it("high-velocity first org: withholds credits but STILL stamps (no refarm)", async () => {
    userRow.signupIp = "203.0.113.7";
    ipPeerCount = 5; // >= block threshold
    await createOrgForUser("u1", "Test User");
    expect(claimCalled).toBe(true); // consumed even though withheld
    expect(createdData?.freeCreditBalance).toBeUndefined(); // no credits
    expect(createdData?.welcomeRiskScore).toBeGreaterThan(0);
    expect(String(createdData?.welcomeRiskReason)).toContain("ip_velocity");
  });

  it("already granted (welcomeGrantedAt set): no credits, no re-claim", async () => {
    userRow.welcomeGrantedAt = new Date("2026-01-01T00:00:00Z");
    await createOrgForUser("u1", "Test User");
    expect(claimCalled).toBe(false);
    expect(createdData?.freeCreditBalance).toBeUndefined();
    expect(createdData?.welcomeRiskScore).toBeUndefined();
  });

  it("delete-recreate (owns a soft-deleted org): no credits, no claim", async () => {
    everOwnedCount = 1; // hasEverOwnedOrg → true
    await createOrgForUser("u1", "Test User");
    expect(claimCalled).toBe(false);
    expect(createdData?.freeCreditBalance).toBeUndefined();
  });
});
