import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let binaryHome: string;
let binary: string;
const userToken = `oct_u_${"1".repeat(64)}`;
const childTokens = { alpha: `oct_${"a".repeat(64)}`, beta: `oct_${"b".repeat(64)}` };
beforeAll(async () => {
  binaryHome = await mkdtemp(join(tmpdir(), "octp-org-binary-"));
  binary = join(binaryHome, "octp");
  const build = Bun.spawn([process.execPath, "build", fileURLToPath(new URL("../index.tsx", import.meta.url)), "--compile", "--outfile", binary], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (code) throw new Error(`Build failed: ${out}${err}`);
}, 30_000);
afterAll(async () => { await rm(binaryHome, { recursive: true, force: true }); });

describe("compiled multi-organisation CLI", () => {
  it("signs in without an organisation and stores only the user session", async () => {
    let requestedScope: unknown;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/cli/auth/device") {
        requestedScope = await request.json();
        return Response.json({ scope: "user", deviceCode: "d".repeat(40), expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      if (path === "/api/cli/auth/poll") return Response.json({ status: "approved", scope: "user", token: userToken, organization: null, user: { name: "Test User", email: "user@example.test" } });
      return new Response("Unexpected request", { status: 500 });
    } });
    const home = await mkdtemp(join(tmpdir(), "octp-org-login-"));
    try {
      const child = Bun.spawn([binary, "login", "--no-open", "--api-url", `http://127.0.0.1:${server.port}`], { cwd: home, env: { ...process.env, OCTOPUS_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code).toBe(0);
      expect(requestedScope).toEqual({ scope: "user" });
      expect(out + err).not.toContain(userToken);
      expect(out + err).toContain("user@example.test");
      expect(JSON.parse(await readFile(join(home, "profiles", "default", "credentials"), "utf8"))).toMatchObject({ kind: "user", token: userToken, orgId: "", orgSlug: "" });
    } finally { server.stop(true); await rm(home, { recursive: true, force: true }); }
  }, 15_000);
  it("switches one user credential by repository or --org, and blocks ambiguity before work", async () => {
    const calls: { path: string; method: string; auth: string | null; repo: string | null }[] = [];
    let revoked = false;
    let availableSlugs = ["alpha", "beta"];
    let hasInstallation = true;
    let connectedRepository = "";
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization");
      calls.push({ path: url.pathname, method: request.method, auth, repo: url.searchParams.get("repo") });
      if (url.pathname === "/api/cli/organizations") {
        if (auth !== `Bearer ${userToken}` || revoked) return Response.json({ error: "Sign in again" }, { status: 401 });
        if (request.method === "GET") return Response.json({ organizations: availableSlugs.map((slug) => ({
          id: slug, slug, name: slug, hasInstallation,
          matchesRepository: url.searchParams.get("repo") === "shared/app" || url.searchParams.get("repo") === `${slug}/app`, matchesOwner: false,
        })) });
        const body = await request.json() as { organization: keyof typeof childTokens };
        const slug = body.organization;
        return Response.json({ token: childTokens[slug], organization: { id: slug, slug, name: slug } });
      }
      const selected = Object.entries(childTokens).find(([, token]) => auth === `Bearer ${token}`)?.[0];
      if (!selected) return Response.json({ error: "Wrong credential scope" }, { status: 401 });
      if (url.pathname === "/api/cli/repos") return Response.json({ repos: [
        { id: "shared-repo", name: "app", fullName: "shared/app", provider: "github" },
        { id: "local-repo", name: "app", fullName: "alpha/app", provider: "github" },
      ] });
      if (url.pathname === "/api/cli/chat") return new Response('data: {"type":"delta","text":"Answer"}\ndata: [DONE]\n', { headers: { "content-type": "text/event-stream" } });
      if (url.pathname === "/api/cli/repos/connect") {
        connectedRepository = (await request.json() as { fullName: string }).fullName;
        return Response.json({ state: "connected", repoId: `${selected}-repo` });
      }
      if (url.pathname === `/api/cli/repos/${selected}-repo/status`) return Response.json({ repo: {
        id: `${selected}-repo`, fullName: connectedRepository, provider: "github", indexStatus: "indexed", analysisStatus: "analyzed",
        indexedAt: "2026-09-12T00:00:00Z", analyzedAt: "2026-09-12T00:01:00Z", indexedFiles: 10, totalFiles: 10, analysis: `${selected} analysis`,
      } });
      return Response.json({ error: "Unexpected request" }, { status: 404 });
    } });
    const home = await mkdtemp(join(tmpdir(), "octp-org-user-"));
    const credential = JSON.stringify({ kind: "user", baseUrl: `http://127.0.0.1:${server.port}`, token: userToken, orgId: "", orgSlug: "", orgName: "", approvedAt: "2026-09-12" });
    await writeFile(join(home, "credentials"), credential, { mode: 0o600 });
    async function run(args: string[]) {
      const child = Bun.spawn([binary, ...args], { cwd: home, env: { ...process.env, OCTOPUS_HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(out + err).not.toContain(userToken);
      for (const token of Object.values(childTokens)) expect(out + err).not.toContain(token);
      return { code, out, err };
    }
    try {
      const list = await run(["org", "list", "--json"]);
      expect(list.code).toBe(0);
      expect(JSON.parse(list.out).organizations).toHaveLength(2);
      for (const slug of ["alpha", "beta"]) {
        const result = await run(["onboard", "--agent", "--json", "--repo", `${slug}/app`]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.out)).toMatchObject({ state: "ready", result: { analysis: `${slug} analysis` } });
        expect(JSON.parse(result.out).continueWith).toContain(slug);
      }
      const explicit = await run(["--org", "beta", "onboard", "--agent", "--json", "--repo", "alpha/app"]);
      expect(explicit.code).toBe(0);
      expect(JSON.parse(explicit.out).result.analysis).toBe("beta analysis");
      for (const args of [[], ["--org", "missing"]]) {
        calls.length = 0;
        const result = await run([...args, "onboard", "--agent", "--json", "--repo", "unknown/app"]);
        expect(result.code).toBe(3);
        expect(JSON.parse(result.out)).toMatchObject({ state: "organization_required", organizations: [{ slug: "alpha" }, { slug: "beta" }] });
        expect(calls.every((call) => call.path === "/api/cli/organizations" && call.method === "GET")).toBe(true);
      }
      for (const args of [["init", "--quiet"], ["remote", "add", "origin", "https://github.com/alpha/app.git"]]) {
        expect(spawnSync("git", args, { cwd: home }).status).toBe(0);
      }
      for (const args of [
        ["chat", "-p", "Summarize", "shared/app"],
        ["chat", "--print", "Summarize", "shared/app"],
        ["repo", "--", "index", "shared/app"],
        ["repo", "index", "--", "shared/app"],
        ["repo", "--", "analyze", "shared/app"],
        ["review", "https://github.com/shared/app/pull/12"],
        ["review", "--format", "json", "https://github.com/shared/app/pull/12"],
        ["review", "--pr", "https://github.com/shared/app/pull/12"],
        ["analyze-deps", "https://github.com/shared/app"],
        ["analyze-deps", "https://github.com/shared/app/tree/main"],
      ]) {
        calls.length = 0;
        const ambiguous = await run(args);
        expect(ambiguous.code).toBe(3);
        expect(ambiguous.err).toContain("--org alpha");
        expect(ambiguous.err).toContain("--org beta");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: "GET", repo: "shared/app" });
        calls.length = 0;
        await run(["--org", "beta", ...args]);
        expect(calls.some((call) => call.method === "POST" && call.path === "/api/cli/organizations")).toBe(true);
        expect(calls.some((call) => call.auth === `Bearer ${childTokens.beta}`)).toBe(true);
      }
      const shortTargets = [
        ["chat", "-p", "Summarize", "app"],
        ["chat", "app", "--print", "Summarize"],
        ["repo", "--", "index", "app"],
        ["repo", "analyze", "--", "app"],
      ];
      for (const args of shortTargets) {
        calls.length = 0;
        const result = await run(args);
        expect(result.code).toBe(3);
        expect(result.err).toContain("--org alpha");
        expect(result.err).toContain("--org beta");
        expect(calls).toEqual([{ path: "/api/cli/organizations", method: "GET", auth: `Bearer ${userToken}`, repo: null }]);
        calls.length = 0;
        await run(["--org", "beta", ...args]);
        expect(calls.some((call) => call.method === "POST" && call.auth === `Bearer ${childTokens.beta}` && call.path !== "/api/cli/organizations")).toBe(true);
      }
      availableSlugs = ["alpha"];
      hasInstallation = false;
      for (const args of [shortTargets[0], ["chat", "-p", "Summarize", "unknown/app"]]) {
        calls.length = 0;
        expect((await run(args)).code).toBe(3);
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("GET");
      }
      availableSlugs = ["alpha", "beta"];
      hasInstallation = true;
      calls.length = 0;
      expect((await run(["chat", "-p", "Summarize"])).code).toBe(0);
      expect(calls[0].repo).toBe("alpha/app");
      const credentialPath = join(home, "profiles", "default", "credentials");
      await writeFile(credentialPath, JSON.stringify({ ...JSON.parse(credential), kind: undefined, token: childTokens.alpha, orgId: "alpha", orgSlug: "alpha" }));
      calls.length = 0;
      expect((await run(shortTargets[0])).code).toBe(0);
      expect(calls.every((call) => call.path !== "/api/cli/organizations" && call.auth === `Bearer ${childTokens.alpha}`)).toBe(true);
      await writeFile(credentialPath, credential);
      calls.length = 0;
      await run(["review", "--since", "main", "--format", "json", "12"]);
      expect(calls[0].repo).toBe("alpha/app");
      for (const args of [["agent", "watch", "--list"], ["agent", "watch", "--remove"]]) {
        calls.length = 0;
        expect((await run(args)).code).toBe(0);
        expect(calls).toHaveLength(0);
        const invalid = await run(["--org", "alpha", ...args]);
        expect(invalid.code).toBe(2);
        expect(invalid.err).toContain("Local agent watch");
        expect(calls).toHaveLength(0);
      }
      revoked = true;
      calls.length = 0;
      const denied = await run(["--org", "alpha", "onboard", "--agent", "--json", "--repo", "alpha/app"]);
      expect(denied.code).toBe(3);
      expect(JSON.parse(denied.out).state).toBe("authentication_required");
      expect(calls).toHaveLength(1);
      expect(await readFile(join(home, "profiles", "default", "credentials"), "utf8")).toBe(credential);
      server.stop(true);
      expect((await run(["agent", "watch", "--list"])).code).toBe(0);
      expect((await run(["agent", "watch", "--remove"])).code).toBe(0);

    } finally { server.stop(true); await rm(home, { recursive: true, force: true }); }
  }, 30_000);
});
