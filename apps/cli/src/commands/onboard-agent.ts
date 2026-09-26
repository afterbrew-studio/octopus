import { detectOnboardingRepository } from "../lib/git-repository.js";
export { detectOnboardingRepository } from "../lib/git-repository.js";
import { resolveOrganization, getOrganizationOverride } from "../lib/organizations.js";
import { loadCredentials } from "../lib/credentials.js";
import { loadConfig } from "../lib/config.js";
import { getActiveProfileName } from "../lib/paths.js";
import { getJson, postJson, normalizeBaseUrl, isTransportSafe } from "../lib/api.js";
import { advanceAgentOnboarding, onboardingResult, onboardingExitCode, type Connection, type OnboardingContext } from "../lib/agent-onboarding.js";

// Console output can be buffered in a compiled binary. Await the stream write
// before returning an exit code so pipe readers receive the entire JSON result.
function writeResult(result: ReturnType<typeof onboardingResult>): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function parseAgentOnboardingArgs(argv: string[]): { repo?: string; help?: boolean } {
  let repo: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw new Error("Duplicate onboarding flag.");
    seen.add(arg);
    if (arg === "--repo") {
      repo = argv[++i];
      if (!repo || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo) || [".", ".."].includes(repo.split("/")[1])) throw new Error("--repo requires a GitHub owner/repository name.");
    } else if (arg === "--help" || arg === "-h") return { help: true };
    else if (arg !== "--agent" && arg !== "--json") throw new Error("Unknown agent onboarding argument. Use --repo owner/name, --json or --help.");
  }
  return { repo };
}


export async function onboardAgentCommand(argv: string[]): Promise<number> {
  const context: OnboardingContext = { account: getActiveProfileName(), repository: "", baseUrl: "https://octopus-review.ai" };
  let parsed: ReturnType<typeof parseAgentOnboardingArgs>;
  try {
    parsed = parseAgentOnboardingArgs(argv);
    if (parsed.help) {
      console.log("Usage: octp onboard --agent --json [--repo owner/name]\nRuns one resumable setup step for GitHub. Exit 0: ready; 3: waiting/action needed; 2: invalid input; 1: failed.\nFollow nextAction, wait retryAfterSeconds, then execute continueWith. Browser approvals remain with the user.");
      return 0;
    }
    context.repository = parsed.repo ?? detectOnboardingRepository();
  } catch (error) {
    await writeResult(onboardingResult(context, "invalid_input", error instanceof Error ? error.message : "Invalid input."));
    return 2;
  }
  try {
    let creds = await loadCredentials();
    const candidate = creds?.baseUrl ?? (await loadConfig()).selfHostedBaseUrl ?? context.baseUrl;
    const baseUrl = normalizeBaseUrl(candidate);
    if (!baseUrl || !isTransportSafe(baseUrl)) throw new Error("unsafe_server");
    context.baseUrl = baseUrl;
    context.org = getOrganizationOverride();
    if (creds) {
      const resolved = await resolveOrganization(creds, context.org, context.repository);
      if (!resolved.ok) {
        const result = onboardingResult(context, resolved.state, resolved.message);
        result.organizations = resolved.organizations;
        if (resolved.state === "authentication_required") result.nextAction = { kind: "run_command", argv: ["octp", "--account", context.account, "login", "--no-open", "--api-url", baseUrl] };
        await writeResult(result);
        return onboardingExitCode(result);
      }
      creds = resolved.credentials;
      context.organization = { id: creds.orgId, name: creds.orgName };
      if (resolved.userSession) context.org = creds.orgSlug;
    }
    const result = !creds ? (() => {
      const result = onboardingResult(context, "authentication_required", "Run login, show its approval URL to the user, wait for login to finish, then resume setup.");
      result.nextAction = { kind: "run_command" as const, argv: ["octp", "--account", context.account, "login", "--no-open", "--api-url", baseUrl] };
      return result;
    })() : await advanceAgentOnboarding(context, {
      connect: () => postJson<Connection>(`${baseUrl}/api/cli/repos/connect`, { fullName: context.repository }, creds.token, { timeoutMs: 30_000 }),
      status: (id) => getJson(`${baseUrl}/api/cli/repos/${encodeURIComponent(id)}/status`, { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) }),
      start: (id, operation) => postJson(`${baseUrl}/api/cli/repos/${encodeURIComponent(id)}/${operation}`, {}, creds.token, { timeoutMs: 15_000 }),
    });
    await writeResult(result);
    return onboardingExitCode(result);
  } catch {
    await writeResult(onboardingResult(context, "failed", "Could not complete this setup step. Check server connectivity and local account configuration, then resume. No completion is assumed."));
    return 1;
  }
}
