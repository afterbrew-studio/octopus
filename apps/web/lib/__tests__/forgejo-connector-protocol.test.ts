import { describe, expect, it } from "bun:test";
import { normalizeForgejoHost } from "@octopus/forgejo-connector/http";
import {
  FORGEJO_MAX_RESPONSE_BYTES, validateForgejoCommand, validateForgejoOperation, validateForgejoResult,
  type ForgejoOperation,
} from "@octopus/forgejo-connector/protocol";

const sha = "a".repeat(40);
const binding = { id: "command_1", leaseToken: "b".repeat(64) };
const op = (path: string, method: ForgejoOperation["method"] = "GET", body?: unknown): ForgejoOperation => ({
  path: `/api/v1${path}`, method, maxBytes: 1024, ...(body !== undefined ? { body } : {}),
});

describe("Forgejo connector trust boundary", () => {
  it("allows exactly the API operations used by discovery, indexing and reviews", () => {
    for (const operation of [
      op("/user"), op("/user/repos?limit=50&page=200&order_by=id"),
      op("/repos/owner/repo/pulls/12"), op("/repos/owner/repo/pulls/12.diff"),
      op("/repos/owner/repo/pulls/12/files?limit=50&page=60"),
      op("/repos/owner/repo/branches/feature%2Ffix"),
      op("/repos/owner/repo/branches/release100%25"),
      op("/repos/owner/repo/contents/src/100%25-coverage.ts?ref=release100%25"),
      op("/repos/owner/repo/contents/src/percent%2520name.ts"),
      op(`/repos/owner/repo/git/trees/${sha}?recursive=true&per_page=1000&page=100`),
      op("/repos/owner/repo/contents/src/a%20file.ts?ref=feature%2Ffix"),
      op("/repos/owner/repo/issues/12/comments", "POST", { body: "Review" }),
      op("/repos/owner/repo/issues/comments/34", "PATCH", { body: "Updated review" }),
      op("/repos/owner/repo/pulls/12/reviews", "POST", { body: "Review", event: "COMMENT", commit_id: sha,
        comments: [{ path: "src/a.ts", body: "Finding", new_position: 3, old_position: 0 }] }),
      op(`/repos/owner/repo/statuses/${sha}`, "POST", { state: "success", context: "Octopus", description: "Complete", target_url: "https://octopus-review.ai/review/123" }),
    ]) expect(() => validateForgejoOperation(operation)).not.toThrow();
  });

  it("rejects arbitrary network requests, traversal, API administration and write escalation", () => {
    for (const operation of [
      op("/admin/users"), op("/user?token=secret"), op("/user?constructor=ignored"),
      op("/user?toString=ignored"), op("/user/repos?limit=50&limit=2"),
      op("/repos/owner%2Frepo/repo/pulls/1"), op("/repos/%252e%252e/repo/pulls/1"),
      op("/repos/owner/repo/contents/../hooks"), op("/repos/owner/repo/contents/%2e%2e/hooks"),
      op("/repos/owner/repo/contents/%252e%252e/hooks"),
      op("/repos/owner/repo/contents/a%252Fb"),
      op("/repos/owner/repo/contents/a%25255Cb"),
      op("/repos/owner/repo/branches/%252e%252e%252fmain"),
      op("/repos/owner/repo/contents/a?ref=%252e%252e%252fmain"),
      op("/repos/owner/repo/contents/a%2Fb"), op("/repos/owner/repo/contents/a?ref=../main"),
      op("/repos/owner/repo/pulls/1/merge", "POST", {}),
      op("/repos/owner/repo/issues/1/comments", "POST", { body: "x", assignees: ["admin"] }),
      op("/repos/owner/repo/pulls/1/reviews", "POST", { body: "x", event: "APPROVE", commit_id: sha, comments: [] }),
      op(`/repos/owner/repo/statuses/${sha}`, "POST", { state: "success", context: "x", description: "x", target_url: "javascript:alert(1)" }),
      { ...op("/user"), path: "https://other.example/api/v1/user" },
      { ...op("/user"), body: {} }, { ...op("/user"), maxBytes: FORGEJO_MAX_RESPONSE_BYTES + 1 },
      { ...op("/user"), maxBytes: NaN },
    ]) expect(() => validateForgejoOperation(operation)).toThrow();
  });

  it("validates lease bindings and returns only bounded response data", () => {
    const command = { ...op("/user"), ...binding, expiresAt: new Date().toISOString() };
    expect(validateForgejoCommand(command)).toEqual(command);
    for (const value of [{ ...command, leaseToken: "short" }, { ...command, url: "https://evil.test" }, { ...command, expiresAt: "tomorrow" }]) {
      expect(() => validateForgejoCommand(value)).toThrow();
    }
    for (const result of [
      { ...binding, result: { body: "{}", headers: { "x-hasmore": "false" } } },
      { ...binding, error: "http", status: 404 }, { ...binding, error: "failed" }, { ...binding, error: "too_large" },
    ]) expect(validateForgejoResult(result)).toEqual(result);
    for (const result of [
      { ...binding, result: { body: "{}", headers: { authorization: "secret" } } },
      { ...binding, result: { body: "x".repeat(FORGEJO_MAX_RESPONSE_BYTES + 1), headers: {} } },
      { ...binding, error: "http", status: 200 }, { ...binding, error: "failed", status: 500 },
      { ...binding, error: "failed", result: { body: "{}", headers: {} } },
    ]) expect(() => validateForgejoResult(result)).toThrow();
  });

  it("requires explicit private-network opt in and always blocks metadata and loopback", () => {
    expect(() => normalizeForgejoHost("https://192.168.1.2")).toThrow();
    expect(normalizeForgejoHost("https://192.168.1.2", { allowPrivate: true })).toBe("https://192.168.1.2");
    expect(normalizeForgejoHost("https://[fd12::2]", { allowPrivate: true })).toBe("https://[fd12::2]");
    for (const host of ["http://192.168.1.2", "https://127.0.0.1", "https://169.254.169.254", "https://100.100.100.200", "https://[::1]", "https://[fd00:ec2::254]"]) {
      expect(() => normalizeForgejoHost(host, { allowPrivate: true })).toThrow();
    }
  });
});
