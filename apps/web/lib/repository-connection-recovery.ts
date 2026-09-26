export function getRepositoryConnectionRecovery(provider: string, orgId: string, returnTo: string) {
  if (provider === "github") {
    const params = new URLSearchParams({ orgId, returnTo });
    return { href: `/api/github/install?${params}`, label: "Check GitHub access" };
  }
  const names: Record<string, string> = { bitbucket: "Bitbucket", gitlab: "GitLab", forgejo: "Forgejo" };
  const name = names[provider];
  return {
    href: name ? `/settings/integrations#${provider}` : "/settings/integrations",
    label: name ? `Check ${name} connection` : "Check provider connection",
  };
}
