import { describe, expect, it } from "bun:test";
import { resolveIndexGate } from "@/lib/usable-index";

const completed = { indexedAt: new Date("2026-10-01T00:00:00Z"), totalVectors: 12_000 };
const never = { indexedAt: null, totalVectors: 0 };

describe("resolveIndexGate", () => {
  it("never blocks or refreshes an indexed repository", () => {
    expect(resolveIndexGate({ indexStatus: "indexed", ...completed })).toEqual({ blockOnIndex: false, refresh: false });
  });

  it.each(["stale", "failed", "pending", "cancelled"])("reviews a %s repository with a completed snapshot and refreshes it", (indexStatus) => {
    expect(resolveIndexGate({ indexStatus, ...completed })).toEqual({ blockOnIndex: false, refresh: true });
  });

  it("reviews against the snapshot while a refresh is already running", () => {
    expect(resolveIndexGate({ indexStatus: "indexing", ...completed })).toEqual({ blockOnIndex: false, refresh: false });
  });

  it.each(["stale", "failed", "pending", "indexing"])("blocks a %s repository that was never indexed", (indexStatus) => {
    expect(resolveIndexGate({ indexStatus, ...never })).toEqual({ blockOnIndex: true, refresh: false });
  });

  it("does not trust a date without vectors, or vectors without a date", () => {
    expect(resolveIndexGate({ indexStatus: "stale", indexedAt: completed.indexedAt, totalVectors: 0 }).blockOnIndex).toBe(true);
    expect(resolveIndexGate({ indexStatus: "stale", indexedAt: null, totalVectors: 5 }).blockOnIndex).toBe(true);
  });
});
