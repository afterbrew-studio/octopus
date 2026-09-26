import { del } from "../lib/api.js";
import { loadCredentials, clearCredentials } from "../lib/credentials.js";
import { hasFlag } from "../lib/args.js";
import { success, error, info, sanitizeTerminal } from "../lib/output.js";

/** `octp logout` — remove saved credentials (~/.octopus/credentials). */
export async function logoutCommand(argv: string[]): Promise<number> {
  if (hasFlag(argv, "--help", "-h")) {
    console.log("octp logout — remove saved credentials (~/.octopus/credentials)");
    return 0;
  }
  const creds = await loadCredentials();
  if (!creds) {
    info("Not signed in — nothing to do.");
    return 0;
  }
  try {
    if (creds.kind === "user") {
      const revoked = await del(`${creds.baseUrl}/api/cli/auth/user`, creds.token, { timeoutMs: 15_000 });
      if (!revoked.ok && revoked.status !== 401) {
        error("Could not revoke the CLI session. Check connectivity and retry logout.");
        return 1;
      }
    }
    await clearCredentials();
    success(creds.kind === "user" ? "Signed out. CLI session revoked." : `Signed out of ${sanitizeTerminal(creds.orgName)}.`);
    return 0;
  } catch (e) {
    // clearCredentials re-throws non-ENOENT — the token is still on disk.
    error(`Could not remove credentials: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
