import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const enabled = process.env.RUN_CREATION_PROVENANCE_DB_TESTS === "1";
const cases = [
  "auto-layout", "auto-profile", "auto-cli", "user-created", "second", "removed-member", "concurrent-organizations",
  "community-action-new", "community-oss-new", "community-action-existing", "community-oss-existing",
  "demo-seed", "github", "google", "microsoft", "oauth-callbacks", "magic-link", "password", "bootstrap",
  "link-later", "invite-pending", "invite-none", "invite-expired", "invite-accepted", "invite-revoked",
  "invitation-unavailable", "method-unknown", "method-unavailable", "membership-unavailable", "migration", "lookup-indexes",
] as const;

(enabled ? describe : describe.skip)("creation provenance with PostgreSQL", () => {
  for (const scenario of cases) {
    it(scenario, async () => {
      const child = Bun.spawn([
        process.execPath,
        fileURLToPath(new URL("./fixtures/creation-provenance-harness.ts", import.meta.url)),
        scenario,
      ], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      // Do not include auth responses, SQL errors or connection details in output.
      expect(code, code === 0 ? "" : `Provenance scenario failed (${scenario}); inspect locally.`).toBe(0);
      expect(stdout.includes("PROVENANCE_OK")).toBe(true);
      expect(stderr.includes("PROVENANCE_FAILURE")).toBe(false);
    }, 30_000);
  }
});
