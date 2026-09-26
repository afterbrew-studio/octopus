import { hasFlag, positionals } from "./args.js";

export function chatArguments(argv: string[]) {
  return {
    repository: positionals(argv, ["-p", "--print"])[0],
    global: hasFlag(argv, "-g", "--global"),
  };
}

export function repoArguments(argv: string[]) {
  const [subcommand, repository] = positionals(argv);
  return { subcommand: subcommand ?? "list", repository };
}

export function dependencyRepositoryArgument(argv: string[]): string | undefined {
  return positionals(argv)[0];
}
