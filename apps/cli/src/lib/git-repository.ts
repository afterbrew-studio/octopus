import { spawnSync } from "node:child_process";

export function detectOnboardingRepository(runGit: (args: string[]) => string | null = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}): string {
  const remotes = runGit(["remote"])?.split("\n").filter(Boolean) ?? [];
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  if (!remote) throw new Error("No unambiguous git remote. Supply --repo owner/name for the intended GitHub repository.");
  const url = runGit(["remote", "get-url", remote]);
  // Accept github.com only; never print a raw remote URL that may contain credentials.
  const match = url?.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (!match || [".", ".."].includes(match[1].split("/")[1])) throw new Error("Agent onboarding currently supports github.com remotes. Supply --repo owner/name only for a GitHub repository.");
  return match[1];
}
