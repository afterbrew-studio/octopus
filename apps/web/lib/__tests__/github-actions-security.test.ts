import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("GitHub Actions supply-chain boundary", () => {
  it("pins every external action to an immutable full commit SHA", () => {
    const workflowsDir = resolve(import.meta.dir, "../../../../.github/workflows");
    const unpinned: string[] = [];

    for (const name of readdirSync(workflowsDir).filter((file) => /\.ya?ml$/.test(file))) {
      const lines = readFileSync(resolve(workflowsDir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        const reference = line.match(/^\s*(?:-\s*)?uses:\s+([^\s#]+)/)?.[1];
        if (!reference || reference.startsWith("./")) return;
        const separator = reference.lastIndexOf("@");
        const revision = separator === -1 ? "" : reference.slice(separator + 1);
        if (!/^[0-9a-f]{40}$/.test(revision)) {
          unpinned.push(`${name}:${index + 1} (${reference})`);
        }
      });
    }

    expect(unpinned).toEqual([]);
  });
});
