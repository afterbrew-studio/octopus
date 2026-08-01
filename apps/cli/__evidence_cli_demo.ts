/* Temporary evidence script — real ensureRepoIndexed run against a real local
 * HTTP server (no mocks). Deleted after the test run. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRepoIndexed } from "./src/lib/local-index";

const base = mkdtempSync(join(tmpdir(), "octp-evidence-"));
const repo = join(base, "victim-repo");
const outside = join(base, "outside");
const decoyCwd = join(base, "attacker-chosen-cwd");
mkdirSync(repo); mkdirSync(outside); mkdirSync(decoyCwd);

writeFileSync(join(outside, "credentials.ts"), "export const apiKey = 'TOP-SECRET-API-KEY-9F3A';\n");
writeFileSync(join(repo, "app.ts"), "export const app = 'LEGITIMATE-REPO-CONTENT';\n");
writeFileSync(join(decoyCwd, "app.ts"), "export const app = 'CONTENT-FROM-PROCESS-CWD-NOT-REPO';\n");
// Attacker plants a tracked symlink pointing outside the repository
symlinkSync(join(outside, "credentials.ts"), join(repo, "stolen.ts"));
spawnSync("git", ["init", "-q"], { cwd: repo });
spawnSync("git", ["add", "--", "app.ts", "stolen.ts"], { cwd: repo });

console.log("repo tracked files (git ls-files):");
console.log(spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n").map(l => "  " + l).join("\n"));

// Real HTTP server standing in for the Octopus API — records every upload.
const uploaded: Array<{ path: string; content: string }> = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/cli/repos/index-local") {
      return req.json().then((body: any) => {
        for (const f of body.files ?? []) uploaded.push(f);
        return Response.json({ repoId: "demo-repo-id", done: true, chunksInBatch: (body.files ?? []).length });
      });
    }
    if (url.pathname.startsWith("/api/cli/repos/")) {
      return Response.json({ repo: { indexStatus: "indexed", indexedFiles: uploaded.length, totalFiles: uploaded.length } });
    }
    return new Response("not found", { status: 404 });
  },
});

// Run the actual CLI flow from a different process CWD than the target repo
process.chdir(decoyCwd);
const result = await ensureRepoIndexed(
  { baseUrl: `http://127.0.0.1:${server.port}`, token: "demo-token" } as any,
  "https://github.com/example/victim-repo.git",
  repo,
  { tty: false },
);
server.stop();

console.log("\nensureRepoIndexed result:", JSON.stringify(result));
console.log("\nfiles the server actually received over HTTP:");
for (const f of uploaded) console.log(`  ${f.path}: ${JSON.stringify(f.content.trim())}`);

const wire = JSON.stringify(uploaded);
const checks: [string, boolean][] = [
  ["upload succeeded end-to-end (indexed)", (result as any).ok === true && (result as any).kind === "indexed"],
  ["legitimate repo file app.ts was uploaded", uploaded.some(f => f.path === "app.ts" && f.content.includes("LEGITIMATE-REPO-CONTENT"))],
  ["tracked symlink stolen.ts was NOT uploaded", !uploaded.some(f => f.path === "stolen.ts")],
  ["secret outside the repo never crossed the wire", !wire.includes("TOP-SECRET-API-KEY-9F3A")],
  ["process-CWD decoy content never crossed the wire", !wire.includes("CONTENT-FROM-PROCESS-CWD-NOT-REPO")],
];
let failed = 0;
console.log("");
for (const [name, ok] of checks) { console.log(`${ok ? "PASS" : "FAIL"} - ${name}`); if (!ok) failed++; }
console.log(failed === 0 ? "ALL C