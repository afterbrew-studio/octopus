import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * Which attempt a large review's result belongs to.
 *
 * internal-cli owns the `post-large-review-result` payload and is not in this
 * repository, so the id may or may not come back with the result. Both branches
 * matter: with an id it is identity, without one it is inference, and the two must
 * not be confused for each other.
 */

const findUnique = mock(async () => ({ id: "att_by_id", configSnapshot: {} }));
const findFirst = mock(async () => ({ id: "att_newest", configSnapshot: {} }));
mock.module("@octopus/db", () => ({
  prisma: { reviewAttempt: { findUnique, findFirst } },
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/github", () => ({
  createPullRequestComment: async () => 0,
  updatePullRequestComment: async () => {},
  createPullRequestReview: async () => {},
  updateCheckRun: async () => {},
}));

const { activeAttempt } = await import("@/lib/large-review-result");

describe("activeAttempt", () => {
  beforeEach(() => {
    findUnique.mockClear();
    findFirst.mockClear();
  });

  it("addresses the attempt by id when the result carried one", async () => {
    const got = await activeAttempt("pr_1", "att_by_id");
    expect(got?.id).toBe("att_by_id");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the newest attempt that has not finished", async () => {
    const got = await activeAttempt("pr_1");
    expect(got?.id).toBe("att_newest");
    expect(findUnique).not.toHaveBeenCalled();
    // The filter is the assertion: a terminal attempt must not be resurrected by
    // a result arriving late, and the newest is the only defensible guess.
    const query = findFirst.mock.calls[0]![0] as {
      where: { pullRequestId: string; terminalAt: null };
      orderBy: { createdAt: string };
    };
    expect(query.where).toEqual({ pullRequestId: "pr_1", terminalAt: null });
    expect(query.orderBy).toEqual({ createdAt: "desc" });
  });
});
