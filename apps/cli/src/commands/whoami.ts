import { loadCredentials } from "../lib/credentials.js";
import { getJson } from "../lib/api.js";
import { hasFlag } from "../lib/args.js";
import { error, info, c, sanitizeTerminal } from "../lib/output.js";

type Me = {
  user: { name: string; email: string };
  organization: { name: string; slug: string; memberCount?: number; repoCount?: number };
};

/** `octp whoami` — show the signed-in user + org (live check via /api/cli/me). */
export async function whoamiCommand(argv: string[]): Promise<number> {
  if (hasFlag(argv, "--help", "-h")) {
    console.log("octp whoami — show the signed-in user and organization");
    return 0;
  }
  const creds = await loadCredentials();
  if (!creds) {
    error("Not signed in. Run `octp login`.");
    return 2;
  }
  if (creds.kind === "user") {
    const identity = await getJson<{ user: { name: string; email: string } }>(`${creds.baseUrl}/api/cli/auth/user`, { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!identity.ok) { error("Session expired or unavailable. Run octp login again."); return 1; }
    info(`${sanitizeTerminal(identity.data.user.name)} <${sanitizeTerminal(identity.data.user.email)}>`);
    info("User session. Use octp org list or --org <slug> for an organisation.");
    return 0;
  }
  const res = await getJson<Me>(`${creds.baseUrl}/api/cli/me`, {
    headers: { authorization: `Bearer ${creds.token}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      error("Session expired or token revoked. Run `octp login` again.");
      return 1;
    }
    if (res.status === 0) {
      error(res.error);
      return 1;
    }
    error(`Could not fetch identity (HTTP ${res.status}: ${res.error})`);
    return 1;
  }
  const { user, organization } = res.data;
  const name = sanitizeTerminal(user.name);
  const email = sanitizeTerminal(user.email);
  const orgName = sanitizeTerminal(organization.name);
  const orgSlug = sanitizeTerminal(organization.slug);
  info(`${c.bold(name)}${email ? ` <${email}>` : ""}`);
  info(`org: ${orgName} (${orgSlug})`);
  const bits: string[] = [];
  if (typeof organization.memberCount === "number") {
    bits.push(`${organization.memberCount} member${organization.memberCount === 1 ? "" : "s"}`);
  }
  if (typeof organization.repoCount === "number") {
    bits.push(`${organization.repoCount} repo${organization.repoCount === 1 ? "" : "s"}`);
  }
  if (bits.length) info(c.dim(bits.join(" · ")));
  info(c.dim(`server: ${creds.baseUrl}`));
  return 0;
}
