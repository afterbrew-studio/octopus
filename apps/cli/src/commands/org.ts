import { loadStoredCredentials } from "../lib/credentials.js";
import { listOrganizations } from "../lib/organizations.js";
import { sanitizeTerminal } from "../lib/output.js";

export async function orgCommand(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log("Usage: octp org list [--json]\nSelect per command with --org <slug>. Sign in once with octp login."); return 0; }
  if (argv[0] !== "list" || argv.slice(1).some((a) => a !== "--json")) { console.error("Usage: octp org list [--json]"); return 2; }
  const creds = await loadStoredCredentials();
  if (!creds || creds.kind !== "user") { console.error("Run octp login to sign in as a user and list your organisations."); return 2; }
  const response = await listOrganizations(creds);
  if (!response.ok) { console.error(response.error); return 1; }
  if (argv.includes("--json")) {
    await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify({ organizations: response.organizations })}\n`, (err) => err ? reject(err) : resolve()));
  } else {
    for (const org of response.organizations) console.log(`${sanitizeTerminal(org.slug)}\t${sanitizeTerminal(org.name)}`);
    if (!response.organizations.length) console.log("No organisations available. Create or join one in Octopus.");
  }
  return 0;
}
