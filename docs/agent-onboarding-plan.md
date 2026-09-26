# AI-driven Octopus onboarding

Implementation proposal • 11 September 2026 • source baseline f88fb33

## First implementation

The current branch implements the non-TTY agent command, direct installation/access
links, scoped target import and live-state continuation through index and analysis.
It uses the existing login process with `--no-open`, rather than persisted device
sessions. It adds atomic claims to the existing start routes. Dedicated pending-owner
approval detection and durable analysis jobs remain future work. See
[the CLI guide](../apps/cli/README.md#set-up-a-repository-with-your-ai) for the exact
implemented contract; the broader design below is the target, not a claim of release.

## The experience

The developer pastes one prompt into the AI session already working on their project. The agent installs octp, identifies the current repository and handles setup. The developer opens a direct link only when sign-in, GitHub authorisation or a real choice needs them. The agent checks the result and continues until the repository is indexed and analysed.

Keep the native CLI installers visible. The primary entry point is “Give your AI this prompt. Let it handle the rest.” Defer model and BYOK choices when the organisation already has a usable default. Preserve an explicit self-hosted path.

## What the code already does

Sign-in prints an approval URL and polls for completion. The GitHub App callback verifies access, imports authorised repositories and queues pending indexes. Repository index and analyse commands both poll status.

The missing connection is orchestration. RepoStep loads repositories once and offers a browser link, but does not poll for the target repo after approval. The standalone resolver returns “not connected” with a suggestion to list repos. The wizard can finish with preferences saved while the repository is still disconnected. Repository output is human text, so agents do not have a stable next-action contract.

These are source findings at f88fb33, with CLI package version 0.4.0. They are not a completed fresh-account browser test or proof that every change is in the distributed binary.

## One resumable command

Proposed interface: octp onboard --agent --json. It runs without an interactive terminal and emits one versioned JSON result. Existing octp onboard keeps its interactive wizard. The agent command checks server capabilities before starting and reports an unsupported version explicitly.

Identify the target by provider, host and full repository name from the current remote. Reuse the active Octopus account, but make account and organisation identity visible. If multiple remotes or organisations leave the target ambiguous, return a choice instead of silently picking the first one.

Each invocation discovers live state and advances available work until it needs a person or a background job. Return state, target, completed steps, next action, approval URL when applicable, expiry, retry interval and a continuation command. Use exit 0 for ready, 3 for actionable waiting, 2 for invalid input or a required choice, and 1 for a failure. These are new command semantics; existing exit codes remain unchanged.

Store resumable state beneath OCTOPUS_HOME, scoped to server, account, organisation and repository. Keep credentials and device-flow secrets in protected storage, separate from preferences and JSON output. Re-running the same command resumes that target. An optional bounded wait mode can poll; the agent can always use short invocations and keep talking to the developer.

## Bring the right approval link

When sign-in is required, return the existing device approval URL. Split the shared device-flow helper into begin, poll and complete operations so the command can exit and resume without issuing a new login request every time.

When GitHub access is missing, ask the server for the next authorised action. For a new installation, reuse the signed install-start route with the intended Octopus organisation. For an existing installation that excludes the target repo, return its verified repository-access settings URL. Do not force another install when access is already sufficient.

Add a narrow connection-status API that distinguishes installation required, organisation approval pending, repository access required, repository syncing and ready. Scope responses to the caller and exact target. Preserve browser session, membership, signed state and installation-ownership checks. Existing browser authentication may still be required after CLI sign-in.

After approval, verify that the target repository is imported and accessible. A completed browser redirect alone is not success. Preserve deliberately dismissed repositories; offer an explicit restore decision instead of reactivating them. If GitHub requires an organisation owner, explain that and keep the continuation available. Never claim that sending an approval request grants access.

## Finish the work and recover cleanly

If indexing was queued by the callback or is running, follow it. Otherwise enqueue through the existing singleton repository-index job. Use an atomic claim for any new start path so retries and two agents do not create duplicate work. Treat an already-running response as progress, not a failed onboarding.

Wait for indexing to reach its successful terminal state before analysis. Reuse a completed analysis when it is current; otherwise start it once. Add durable analysis execution and a run identifier before promising reliable recovery across a server rollout. The current CLI analysis route starts work in the request process; local CLI checkpoints cannot make that server work durable.

Finish with the target repository, index counts, completion timestamps and the actual architecture analysis. The status API already selects the analysis text, but the terminal status command currently prints purpose and summary only. Return the full analysis in agent output, with a bounded preview for the person.

Expired links produce a fresh approval step. Network interruptions preserve progress. Revoked access, account restrictions and unavailable credits produce specific actions. Timeouts report waiting or an unresolved job, never ready. Do not silently switch accounts, providers or billing settings. GitLab, Bitbucket and self-hosted servers receive capability-specific guidance rather than a Cloud GitHub URL.

## Implement in this order

1. Add the agent command, strict argument validation, versioned output and a testable state reducer. Separate device-flow start/poll/complete and keep the current wizard working.
2. Add server connection status and approval-link resolution. Reuse installation verification and repository sync; expose pending approval and missing target access clearly.
3. Connect durable indexing and analysis, retry-safe job claims and result retrieval. Add restart recovery and exact-target completion checks.
4. Update the prompt to use the released command. Add a browser completion message telling the developer their agent will continue. Keep the fallback prompt until the native release and deployed APIs support the new contract.

The CLI lives in apps/cli: its scoped AGENTS.md explicitly identifies it as the replacement native CLI. The root note about the old npm package is stale. Keep application and CLI releases separate, then verify the installed binary against the deployed API before claiming the flow is live.

## Verification and success criteria

Cover a new account, existing installation, missing selected repo, owner approval pending, wrong organisation, ambiguous remotes, dismissed repo, expired login, revoked token and interrupted network. Run commands without a TTY and assert machine-readable output never contains tokens.

Interrupt the agent after each phase, rerun the same command, and prove completed work is reused. Test two concurrent agents, an already-running index, server restart during analysis and delayed repository sync. Mock provider boundaries in automated tests; use a dedicated consented test organisation for the complete browser journey.

Before submitting implementation, run repository lint, typecheck, tests and build, plus CLI compile checks. Measure time to first completed analysis, manual navigation steps, repeated prompts and recovery success. The desired result is zero manual Octopus dashboard navigation for the supported GitHub path, with only the approvals required by account state.

## Source evidence

- [CLI entry point](../apps/cli/src/index.tsx)
- [Device flow](../apps/cli/src/lib/auth.ts)
- [Repository wizard](../apps/cli/src/steps/RepoStep.tsx)
- [Repository commands](../apps/cli/src/commands/repo.ts)
- [Repository resolver](../apps/cli/src/lib/repo-resolver.ts)
- [Wizard completion](../apps/cli/src/steps/DoneStep.tsx)
- [Signed install route](../apps/web/app/api/github/install/route.ts)
- [GitHub callback](../apps/web/app/api/github/callback/route.ts)
- [Durable index job](../apps/web/lib/repository-index-job.ts)
- [Analysis route](../apps/web/app/api/cli/repos/[id]/analyze/route.ts)
- [Status result](../apps/web/app/api/cli/repos/[id]/status/route.ts)
