import { describe, expect, it } from "bun:test";
import { mayApprove, unaddressedPriorFindings } from "@/lib/review-helpers";

/**
 * A review is one non-deterministic run, so a finding it does not repeat has not
 * been answered - it has only gone unmentioned. Treating the two the same turns
 * any push into an approval: rayf #646 went 7 findings -> 0 across a commit
 * adding three comment lines to one file, and approved with six standing.
 */

const clean = { hasCritical: false, hasHigh: false, hasMedium: false };
const prior = [
  { signature: "sig-a", filePath: "Sources/A.swift" },
  { signature: "sig-b", filePath: "Sources/B.swift" },
];

describe("findings an earlier review left open", () => {
  it("counts one this run did not repeat on a file nothing touched", () => {
    const left = unaddressedPriorFindings({
      prior,
      currentSignatures: new Set<string>(),
      changedSince: ["Docs/notes.md"],
    });
    expect(left.map((f) => f.signature)).toEqual(["sig-a", "sig-b"]);
  });

  it("clears one this run repeated, because the reviewer had its say", () => {
    const left = unaddressedPriorFindings({
      prior,
      currentSignatures: new Set(["sig-a"]),
      changedSince: [],
    });
    expect(left.map((f) => f.signature)).toEqual(["sig-b"]);
  });

  it("clears one whose file a later commit touched", () => {
    const left = unaddressedPriorFindings({
      prior,
      currentSignatures: new Set<string>(),
      changedSince: ["Sources/A.swift"],
    });
    expect(left.map((f) => f.signature)).toEqual(["sig-b"]);
  });

  it("counts every one when the comparison could not be read", () => {
    // "Cannot tell" must not approve.
    const left = unaddressedPriorFindings({
      prior,
      currentSignatures: new Set<string>(),
      changedSince: null,
    });
    expect(left).toHaveLength(2);
  });

  it("counts one with no file, which no comparison can clear", () => {
    const left = unaddressedPriorFindings({
      prior: [{ signature: "sig-c", filePath: null }],
      currentSignatures: new Set<string>(),
      changedSince: ["Sources/A.swift"],
    });
    expect(left).toHaveLength(1);
  });

  it("is empty when there was no earlier review", () => {
    expect(
      unaddressedPriorFindings({ prior: [], currentSignatures: new Set(), changedSince: null }),
    ).toHaveLength(0);
  });
});

describe("approval", () => {
  const approvable = {
    optedIn: true,
    found: clean,
    parsedOutput: true,
    readWholeDiff: true,
  };

  it("is withheld while an earlier finding is unaddressed", () => {
    expect(mayApprove({ ...approvable, unaddressedPrior: 1 })).toBe(false);
  });

  it("is given when none is", () => {
    expect(mayApprove({ ...approvable, unaddressedPrior: 0 })).toBe(true);
  });

  it("is unchanged when the question was not asked", () => {
    // Callers that do not pass the count keep the previous behaviour exactly.
    expect(mayApprove(approvable)).toBe(true);
  });

  it("still refuses for the reasons it already refused", () => {
    expect(mayApprove({ ...approvable, parsedOutput: false, unaddressedPrior: 0 })).toBe(false);
    expect(mayApprove({ ...approvable, readWholeDiff: false, unaddressedPrior: 0 })).toBe(false);
    expect(mayApprove({ ...approvable, optedIn: false, unaddressedPrior: 0 })).toBe(false);
    expect(
      mayApprove({ ...approvable, found: { ...clean, hasHigh: true }, unaddressedPrior: 0 }),
    ).toBe(false);
  });
});
