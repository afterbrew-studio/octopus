"use client";

import { useRef, useState } from "react";
import { IconCheck, IconCopy } from "@tabler/icons-react";

const SETUP_PROMPT = `Set up Octopus for the GitHub repository in my current project using the native octp CLI.

Read the project's Git remote to identify the repository. If it is ambiguous, ask me which repository to use.

Install or update octp using the official instructions at https://octopus-review.ai/docs/cli (macOS/Linux: https://octopus-review.ai/install.sh; Windows: https://octopus-review.ai/install.ps1). Check octp --help, then run octp onboard --agent --json from this project.

Follow the returned nextAction and continueWith instructions. If sign-in is required, run the supplied login command with --no-open, show me its approval URL, and keep the login process running while I approve. Login signs me in as a user without choosing an organisation. Let octp infer the organisation from the repository. If it returns organization_required, show me the available organisations and retry with --org <slug> after I choose; never guess. Use octp org list --json to inspect my memberships. For GitHub App installation, organisation authorisation or repository access, give me the exact approval URL returned by octp. After approval, continue through the CLI.

Let octp connect this repository, start or join indexing and analysis, and check progress using retryAfterSeconds. Continue until it reports ready or a specific blocker. Report the actual repository, indexing and analysis results. Keep existing organisation settings and never print credentials. Use the browser only for the approvals I need to make.`;

export function LandingAgentPrompt() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      setCopyState("copied");
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      setCopyState("manual");
    }
  }

  return (
    <div id="agent-setup" className="min-w-0 scroll-mt-28 rounded-2xl border border-white/10 bg-[#161616] p-6 text-left sm:p-8">
      <label htmlFor="octopus-setup-prompt" className="block text-lg font-semibold text-white">
        Copy this into your AI
      </label>
      <p id="octopus-prompt-help" className="mt-2 text-sm leading-relaxed text-[#a0a0a0]">
        Open your project in Codex, Claude Code, or another AI with terminal access, then paste the prompt.
      </p>
      <textarea
        ref={promptRef}
        id="octopus-setup-prompt"
        aria-describedby="octopus-prompt-help"
        readOnly
        value={SETUP_PROMPT}
        className="mt-5 h-64 w-full resize-y rounded-xl border border-white/15 bg-[#0c0c0c] p-4 font-mono text-sm leading-relaxed text-[#e0e0e0] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#10D8BE]"
      />
      <button
        type="button"
        onClick={copyPrompt}
        className="mt-4 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#10D8BE] px-6 py-3 text-sm font-semibold text-[#0c0c0c] transition-colors hover:bg-[#0fbfa8] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
      >
        {copyState === "copied" ? <IconCheck className="size-4" aria-hidden="true" /> : <IconCopy className="size-4" aria-hidden="true" />}
        {copyState === "copied" ? "Prompt copied" : "Copy setup prompt"}
      </button>
      <p role="status" className="mt-3 min-h-10 text-sm leading-relaxed text-[#a0a0a0]">
        {copyState === "manual"
          ? "The prompt is selected. Copy it with ⌘C or Ctrl+C, then paste it into your AI."
          : copyState === "copied"
            ? "Paste it into your AI’s session in your project."
            : "GitHub setup is supported. Your AI reads the repository from your project."}
      </p>
    </div>
  );
}
