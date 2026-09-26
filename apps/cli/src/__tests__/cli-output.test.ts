import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../index.tsx", import.meta.url));
let binaryHome: string | undefined;
let cli: string[];

beforeAll(async () => {
  binaryHome = await mkdtemp(join(tmpdir(), "octp-output-binary-"));
  const binary = join(binaryHome, process.platform === "win32" ? "octp.exe" : "octp");
  const build = Bun.spawn([process.execPath, "build", entry, "--compile", "--outfile", binary], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    build.exited, new Response(build.stdout).text(), new Response(build.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Could not compile CLI test binary: ${stdout}${stderr}`);
  cli = [binary];
}, 30_000);

afterAll(async () => {
  if (binaryHome) await rm(binaryHome, { recursive: true, force: true });
});

describe("CLI process output", () => {
  it("delivers the complete analysis to a slow pipe reader before exiting", async () => {
    const analysis = "Repository analysis: café, architecture and dependencies.\n".repeat(16_384);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/api/cli/repos/connect") {
          return Response.json({ state: "connected", repoId: "test-repo" });
        }
        if (request.method === "GET" && path === "/api/cli/repos/test-repo/status") {
          return Response.json({ repo: {
            id: "test-repo", fullName: "acme/app", provider: "github",
            indexStatus: "indexed", analysisStatus: "analyzed",
            indexedAt: "2026-09-10T10:00:00Z", analyzedAt: "2026-09-10T11:00:00Z",
            indexedFiles: 10, totalFiles: 12, analysis,
          } });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const home = await mkdtemp(join(tmpdir(), "octp-pipe-test-"));
    try {
      await writeFile(join(home, "credentials"), JSON.stringify({
        baseUrl: `http://127.0.0.1:${server.port}`, token: "local-test-token",
        orgId: "test-org", orgSlug: "test", orgName: "Test", approvedAt: "2026-09-11T00:00:00Z",
      }));
      const child = Bun.spawn([...cli, "onboard", "--agent", "--json", "--repo", "acme/app"], {
        env: { ...process.env, OCTOPUS_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const stderr = new Response(child.stderr).text();
      await Bun.sleep(100);
      const [output, code, errors] = await Promise.all([
        new Response(child.stdout).text(), child.exited, stderr,
      ]);
      expect(code).toBe(0);
      expect(errors).toBe("");
      expect(output.endsWith("\n")).toBe(true);
      const result = JSON.parse(output);
      expect(result.state).toBe("ready");
      expect(result.result.analysis).toBe(analysis);
    } finally {
      server.stop(true);
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);

  it("preserves the waiting exit code and complete login handoff", async () => {
    const home = await mkdtemp(join(tmpdir(), "octp-login-pipe-"));
    try {
      const child = Bun.spawn([...cli, "onboard", "--agent", "--json", "--repo", "acme/app"], {
        env: { ...process.env, OCTOPUS_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(code).toBe(3);
      expect(errors).toBe("");
      const result = JSON.parse(output);
      expect(result.state).toBe("authentication_required");
      expect(result.nextAction.argv).toContain("--no-open");
      expect(result.continueWith).toContain("acme/app");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 15_000);
});
