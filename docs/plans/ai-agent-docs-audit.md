# AI coding agent documentation audit

Checked 20 September 2026. Scope: the Claude install instructions, native CLI skill claims, agent setup guides, related website/help/navigation content, and the requested footer update.

## Findings and corrections

| Finding | Evidence | Correction |
| --- | --- | --- |
| `claude plugin install octopus` fails on a fresh setup | Claude Code 2.1.276, isolated configuration: plugin not found in configured marketplaces | Document the current publisher marketplace and full `octopus-review@octopus-review` name |
| Two different public plugins were conflated | Legacy `octopusreview/claude-plugin` installs as `octopus@octopus` but calls the old `octopus` executable; current `octopusreview/octopus-plugin` supplies an MCP server | Link the current source, explain the legacy command, separate MCP setup from native CLI prerequisites |
| Token configuration and connection verification were missing | Current plugin install reports an unset `api_token` and instructs `/plugin configure octopus-review@octopus-review` | Add sensitive configuration, restart, `/mcp`, and `octopus_status` steps; installation is not a completed review |
| `octp skills install --claude/--codex` and default both-agent installation were false | Published native octp 0.6.0 rejects those flags; named installation writes `.claude/commands/<name>.md` | Correct CLI and indexed-help instructions; add a separate reusable `SKILL.md` for agent skill directories |
| Existing workflow downloads were not portable Codex skills | They use Claude command metadata and lack a skill `name` | Preserve their existing behavior and clearly distinguish the new shared Octopus skill |
| Other agents had no discoverable setup path | Official tool docs support skill files and command execution | Add Codex, OpenCode, Hermes Agent, OpenClaw and Cursor, with paths, activation, trust requirements and official links |
| Forgejo full PR URLs were implicitly included in generic CLI URL advice | Native CLI 0.6.0 accepts GitHub, GitLab, and Bitbucket URL patterns, not Forgejo `/pulls/` URLs | Use the PR number from the connected checkout for Forgejo |
| Review request success could be mistaken for completion | CLI and MCP PR commands queue server work | Direct users to Review Logs and final PR comments; distinguish local JSON results |
| Marketing claimed an unverified Cursor marketplace installation | A repository manifest does not establish marketplace publication | Offer verified CLI/skill setup and link the separately checked Claude plugin guide |
| Footer attributed the product to Claude alone | Shared landing footer contained the badge | Remove it and add the requested GitHub star/support banner |

Changed content surfaces: Claude docs, AI coding agents guide, native CLI docs, skills overview, getting started, desktop/mobile docs navigation, breadcrumb, sitemap, editor landing page, landing navigation, shared footer, Ask Octopus prompt and indexed documentation, `llms.txt`, and the shared downloadable skill. `llms-full.txt` derives from indexed documentation automatically.

## Verification and limits

- Actual Claude marketplace add, qualified installation and component discovery passed in an isolated configuration. The current plugin reports three skill/command entries and one MCP server; the legacy plugin reports no MCP server.
- Published native `octp-v0.6.0` was downloaded and checked against its release checksum. Executable loopback fixtures covered default local review, staged review, PR number/URL requests and skill installation. No real credentials, AI charges, or real PR writes were used.
- The exact current MCP command, `npx -y github:octopusreview/octopus-plugin`, passed initialization, four-tool discovery, status, local review, PR queuing, normal chat SSE and a blocked-budget response against a loopback fixture. A pinned GitHub SHA variant failed in npm packaging; it is not a documented setup command.
- These checks establish installation and protocol behavior. Agent skill paths are verified against official documentation; they do not establish a complete authenticated review in every agent product. The guides tell users how to verify discovery and their own connection.
- Current MCP 0.1.0 has existing limitations outside this docs change: local summaries omit detailed finding fields; a chat stream with a partial delta followed by an error can be returned as a partial success; its 512 KiB client guard is larger than the API's 500 KiB limit. The docs use the actual API limit, describe brief summaries, and offer the native CLI for structured results. No plugin runtime source was modified.
- The new shared skill requests explicit review scope, preserves authorization for edits/pushes/comments, avoids credential files, and explains that `--no-index` prevents new indexing while existing context can still be used. Local default, staged, and untracked-file semantics are kept distinct.
- Local website lint, typecheck and production build passed; tests passed with 1,853 passing and 53 skipped. Browser checks and the release gates remain required before release. After deployment, refresh the docs index and verify live pages and download contents; source updates alone do not update the hosted knowledge index.

## Primary sources

- [Claude plugin discovery and marketplaces](https://code.claude.com/docs/en/discover-plugins)
- [Current Octopus plugin](https://github.com/octopusreview/octopus-plugin), inspected at `75ff863`
- [Legacy plugin](https://github.com/octopusreview/claude-plugin)
- [Native CLI release](https://github.com/octopusreview/octopus/releases/tag/octp-v0.6.0)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills) and [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [OpenCode skills](https://opencode.ai/docs/skills/)
- [Hermes project skills and trust](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/#project-local-skills)
- [OpenClaw skills](https://docs.openclaw.ai/tools/skills) and [skills CLI](https://docs.openclaw.ai/cli/skills)
- [Cursor skills](https://cursor.com/docs/skills)
