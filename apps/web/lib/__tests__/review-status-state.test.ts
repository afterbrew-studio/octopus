import { describe, expect, it } from "bun:test";
import { applyReviewRequested, applyReviewStatus, type ReviewState } from "@/lib/review-status-state";

const request = (headSha?: string | null) => ({ repoId: "repo", pullRequest: { id: "pr", number: 7, status: "pending", headSha, reviewRequestVersion: headSha ? (headSha === "A" ? 1 : 2) : undefined, title: "Review" } });
const status = (headSha?: string | null, value = "completed") => ({ repoId: "repo", pullRequestId: "pr", number: 7, headSha, reviewRequestVersion: headSha ? (headSha === "A" ? 1 : 2) : undefined, status: value });

describe("dashboard review revision state", () => {
  it("rejects delayed A completion and progress after B is requested", () => {
    let state = applyReviewRequested({}, request("A"));
    state = applyReviewStatus(state, status("A", "reviewing"));
    expect(state.repo[0].status).toBe("reviewing");
    state = applyReviewRequested(state, request("B"));
    expect(applyReviewStatus(state, status("A"))).toBe(state);
    expect(applyReviewStatus(state, status("A", "reviewing"))).toBe(state);
    expect(applyReviewStatus(state, status("A", "failed"))).toBe(state);
    expect(state.repo[0]).toMatchObject({ headSha: "B", status: "pending" });
    state = applyReviewStatus(state, status("B", "reviewing"));
    expect(state.repo[0].status).toBe("reviewing");
    state = applyReviewStatus(state, status("B"));
    expect(state.repo[0]).toMatchObject({ headSha: "B", status: "completed", title: "Review" });
  });

  it("does not let unknown events overwrite a known review", () => {
    const state = applyReviewRequested({}, request("B"));
    for (const head of [undefined, null, ""]) {
      expect(applyReviewStatus(state, status(head))).toBe(state);
      expect(applyReviewRequested(state, request(head))).toBe(state);
    }
    const unknown = applyReviewRequested({}, request());
    expect(applyReviewStatus(unknown, status())).toBe(unknown);
    expect(applyReviewStatus(unknown, status("A"))).toBe(unknown);
    expect(applyReviewRequested(unknown, request("B")).repo[0].headSha).toBe("B");
  });

  it("matches repository, PR identity and head without changing other state", () => {
    const unrelated = [{ id: "other", number: 7, status: "reviewing", headSha: "B", reviewRequestVersion: 2 }];
    const initial: Record<string, ReviewState[]> = { otherRepo: unrelated, repo: [{ id: "pr", number: 7, status: "pending", headSha: "B", reviewRequestVersion: 2 }] };
    expect(applyReviewStatus(initial, { ...status("B"), pullRequestId: "wrong" })).toBe(initial);
    expect(applyReviewStatus(initial, { ...status("B"), repoId: "missing" })).toBe(initial);
    expect(applyReviewStatus(initial, { ...status("B"), number: 8 })).toBe(initial);
    const updated = applyReviewStatus(initial, status("B"));
    expect(updated.otherRepo).toBe(unrelated);
    expect(initial.repo[0].status).toBe("pending");
    expect(updated.repo[0].status).toBe("completed");
  });
});


it("rejects delayed requests and same-head retries using persisted versions", () => {
  const a = request("A"), b = request("B");
  let state = applyReviewRequested({}, b);
  state = applyReviewStatus(state, status("B"));
  expect(applyReviewRequested(state, a)).toBe(state);
  expect(applyReviewStatus(state, status("A"))).toBe(state);
  expect(applyReviewRequested(state, b)).toBe(state);
  const retry = { ...b, pullRequest: { ...b.pullRequest, reviewRequestVersion: 3 } };
  state = applyReviewRequested(state, retry);
  expect(state.repo[0].status).toBe("pending");
  expect(applyReviewRequested(state, b)).toBe(state);
  expect(applyReviewStatus(state, status("B"))).toBe(state);
  state = applyReviewStatus(state, { ...status("B"), reviewRequestVersion: 3 });
  expect(state.repo[0].status).toBe("completed");
  const seeded = { repo: [{ ...b.pullRequest, status: "completed" }] };
  expect(applyReviewRequested(seeded, a)).toBe(seeded);
  expect(applyReviewStatus(seeded, status("A"))).toBe(seeded);
  expect(applyReviewRequested(seeded, { ...a, pullRequest: { ...a.pullRequest, reviewRequestVersion: undefined } })).toBe(seeded);
});
