import { chatArguments, repoArguments, dependencyRepositoryArgument } from "./command-arguments.js";
import { loadStoredCredentials, setCommandCredentials } from "./credentials.js";
import { resolveOrganization } from "./organizations.js";
import { detectOnboardingRepository } from "./git-repository.js";
import { parsePrArg, reviewPrArgument } from "./pr-url.js";
import { sanitizeTerminal } from "./output.js";

export const ORGANIZATION_COMMANDS = ["repo", "review", "chat", "knowledge", "usage", "analyze-deps"];

export function isOrganizationCommand(argv: string[]): boolean {
  return ORGANIZATION_COMMANDS.includes(argv[0]) || (argv[0] === "agent" && argv[1] === "serve");
}

export async function prepareCommandOrganization(argv: string[], orgFlag?: string): Promise<number> {
  const first = argv[0];
  if ((isOrganizationCommand(argv) || (orgFlag && ["whoami", "doctor"].includes(first))) && !argv.includes("--help") && !argv.includes("-h")) {
    const saved = await loadStoredCredentials();
    if (saved) {
      let repository: string | undefined;
      let explicitRepository = false;
      if (saved.kind === "user" && !orgFlag) {
        const args = argv.slice(1);
        if (first === "chat") {
          const target = chatArguments(args);
          if (!target.global) repository = target.repository;
          explicitRepository = repository !== undefined;
        } else if (first === "repo") {
          const target = repoArguments(args);
          if (["status", "index", "analyze"].includes(target.subcommand)) repository = target.repository;
          explicitRepository = repository !== undefined;
        } else if (first === "review") {
          const target = reviewPrArgument(args);
          if (target) {
            const parsed = parsePrArg(target);
            if (!parsed.ok) { console.error(sanitizeTerminal(parsed.error)); return 2; }
            repository = parsed.repoFullName;
            explicitRepository = repository !== undefined;
          }
        } else if (first === "analyze-deps") {
          const target = dependencyRepositoryArgument(args);
          explicitRepository = target !== undefined;
          if (target) {
            try {
              const url = new URL(target.trim());
              const parts = url.pathname.split("/").filter(Boolean);
              if (url.hostname === "github.com" && parts.length >= 2) repository = parts.slice(0, 2).join("/");
            } catch { repository = undefined; }
          }
        }
        if (repository !== undefined && (repository.length > 140 || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || [".", ".."].includes(repository.split("/")[1]))) repository = undefined;
        if (!explicitRepository) { try { repository = detectOnboardingRepository(); } catch { /* No project: require explicit choice when needed. */ } }
      }
      const resolved = await resolveOrganization(saved, orgFlag, repository, explicitRepository);
      if (!resolved.ok) {
        console.error(sanitizeTerminal(resolved.message));
        for (const org of resolved.organizations ?? []) console.error(`  --org ${sanitizeTerminal(org.slug)}  ${sanitizeTerminal(org.name)}`);
        return resolved.state === "organization_required" ? 3 : 1;
      }
      setCommandCredentials(resolved.credentials);
    }
  }
  return 0;
}
