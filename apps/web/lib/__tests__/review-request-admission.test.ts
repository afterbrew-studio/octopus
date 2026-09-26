import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const scenarios = {
  enqueue_retry: "scopes enqueue-failure recovery to Forgejo",
  retry_org_installation: "uses the organization GitHub installation for a legacy administrative retry",
  cli_org_installation: "uses the organization GitHub installation for a legacy CLI review",
  delayed: "rejects a delayed A request after B completed without clearing its report",
  fetch_race: "refreshes provider state when B is admitted during the A head fetch",
  write_race: "refreshes provider state when B wins immediately before the A write",
  create_race: "refreshes provider state after a competing first-row creation",
  same_head_race: "coalesces a same-head request accepted during the provider read",
  contended: "bounds repeated contention without clearing the current report",
  initial: "admits the first provider-confirmed request with version one",
  stuck_retry: "restarts a stuck current-head review with one guarded mutation",
  retry_race: "preserves B when it wins during an administrative retry head fetch",
  cli_race: "rejects a CLI head superseded between its initial lookup and admission",
  same_head: "allows completed same-head re-requests and suppresses active duplicates",
  legacy: "upgrades a legacy null head/version only from authoritative provider state",
  unknown_request: "pins an empty request head to the provider without erasing a known head",
  missing_head: "preserves current state when the provider cannot identify its head",
  provider_failure: "preserves current state when provider lookup fails",
  stale_stuck: "does not fail a stuck newer review for a stale request",
  force_push: "allows a provider-authoritative force push to a previously seen commit",
  retry: "rejects a stale administrative retry through the actual HTTP handler",
  cli_existing: "admits an existing CLI PR with a fresh request version through the HTTP handler",
};
for (const provider of ["github", "bitbucket", "gitlab", "forgejo"]) {
  describe(`${provider} review request admission`, () => {
    for (const [scenario, description] of Object.entries(scenarios)) {
      if (provider !== "github" && scenario.endsWith("_org_installation")) continue;
      it(description, async () => {
        const fixture = fileURLToPath(new URL("./fixtures/review-request-admission-harness.ts", import.meta.url));
        const child = Bun.spawn([process.execPath, fixture, provider, scenario], {
          cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        expect(exitCode, stderr + stdout).toBe(0);
        expect(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!)).toEqual({ scenario, provider, passed: true });
      });
    }
  });
}
