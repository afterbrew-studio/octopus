import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoIndexed } from "../lib/local-index";

describe("ensureRepoIndexed file boundary", () => {
  const originalCwd = process.cwd();
  const originalFetch = globalThis.fetch;
  let base: string;
  let repo: string;
  let elsewhere: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "octp-local-index-"));
    repo = join(base, "repo");
    elsewhere = join(base, "elsewhere");
    const outside = join(base, "outside");
    mkdirSync(repo);
    mkdirSync(elsewhere);
    mkdirSync(outside);

    writeFileSync(join(repo, "safe.ts"), "export const source = 'REPOSITORY_CONTENT';\n");
    writeFileSync(join(elsewhere, "safe.ts"), "export const source = 'PROCESS_CWD_DECOY';\n");
    writeFileSync(join(outside, "secret.ts"), "export const token = 'OUTSIDE_SECRET_8123';\n");
    symlinkSync(join(outside, "secret.ts"), join(repo, "leak.ts"));

    expect(spawnSync("git", ["init", "-q"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["add", "--", "safe.ts", "leak.ts"], { cwd: repo }).status).toBe(0);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    globalThis.fetch = originalFetch;
    rmSync(base, { recursive: true, force: true });
  });

  it("reads from the supplied repository root and never uploads tracked symlink targets", async () => {
    const uploads: Array<{ files: Array<{ path: string; content: string }> }> = [];
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      uploads.push(JSON.parse(String(init?.body)) as (typeof uploads)[number]);
      return new Response(JSON.stringify({ error: "already managed" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    process.chdir(elsewhere);
    const fromOtherCwd = await ensureRepoIndexed(
      { baseUrl: "https://octopus.example", token: "token" },
      "https://github.com/example/repo.git",
      repo,
      { tty: false },
    );

    process.chdir(repo);
    const fromRepoCwd = await ensureRepoIndexed(
      { baseUrl: "https://octopus.example", token: "token" },
      "https://github.com/example/repo.git",
      repo,
      { tty: false },
    );

    expect(fromOtherCwd).toEqual({ ok: true, kind: "platform-managed" });
    expect(fromRepoCwd).toEqual({ ok: true, kind: "platform-managed" });
    expect(uploads).toHaveLength(2);
    for (const upload of uploads) {
      expect(upload.files).toEqual([
        { path: "safe.ts", content: "export const source = 'REPOSITORY_CONTENT';\n" },
      ]);
      expect(JSON.stringify(upload)).not.toContain("PROCESS_CWD_DECOY");
      expect(JSON.stringify(upload)).not.toContain("OUTSIDE_SECRET_8123");
    }
  });
});
