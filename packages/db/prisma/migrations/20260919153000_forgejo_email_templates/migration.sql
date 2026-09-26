-- Refresh only untouched system-template bodies. Preserve custom content,
-- sender settings, subjects, opt-outs, and enabled/disabled state.
-- No emails are sent by this migration.

UPDATE "email_templates"
SET "body" = $forgejo_template$Hey {{firstName}},

Welcome to Octopus, AI-powered code reviews that actually catch real issues.

One thing to know: Octopus gets smarter the more it knows your codebase. Your first review is a starting point.

A few tips to get the most out of it:

- Connect a GitHub, GitLab, Bitbucket or self-hosted Forgejo repository and enable automatic reviews
- Add knowledge docs (style guides, architecture decisions) to make reviews more relevant
- Open your first pull request and check Review Logs in Octopus for its progress

Using Forgejo? Connect your HTTPS instance with a personal access token, then add the repository webhook shown in Settings. For private LAN or VPN instances, run self-hosted Octopus with access to that network. [Follow the Forgejo setup guide]({{appUrl}}/docs/integrations#forgejo). Octopus and your configured AI services process the code for reviews.

Reply anytime, this goes straight to my inbox :)$forgejo_template$,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'welcome'
  AND "system" = true
  AND "body" = $forgejo_template$Hey {{firstName}},

Welcome to Octopus, AI-powered code reviews that actually catch real issues.

One thing to know: Octopus gets smarter the more it knows your codebase. Your first review is a starting point.

A few tips to get the most out of it:

- Connect your GitHub or Bitbucket repo and Octopus will start reviewing PRs automatically
- Add knowledge docs (style guides, architecture decisions) to make reviews more relevant
- React to review comments on GitHub/Bitbucket with thumbs up/down so Octopus learns from your team's preferences

Reply anytime, this goes straight to my inbox :)$forgejo_template$;

UPDATE "email_templates"
SET "body" = $forgejo_template$Hey {{firstName}},

You signed up recently and we want to make sure you're set up for success.

Here's what most teams do in their first week:

- **Connect a GitHub, GitLab, Bitbucket or Forgejo repo** and enable auto-review
- **Add a knowledge doc** (your style guide, architecture decisions, or coding standards) so Octopus reviews like a team member who actually read the docs
- **Check Review Logs** to follow your first review and read its findings

Forgejo needs an HTTPS instance, a personal access token and a signed repository webhook. Private LAN/VPN instances need self-hosted Octopus with network access. [See the setup guide]({{appUrl}}/docs/integrations#forgejo). Let us know if you need help.$forgejo_template$,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'get-started-new-user'
  AND "system" = true
  AND "body" = $forgejo_template$Hey {{firstName}},

You signed up recently and we want to make sure you're set up for success.

Here's what most teams do in their first week:

- **Connect a repo** and enable auto-review so every PR gets reviewed automatically
- **Add a knowledge doc** (your style guide, architecture decisions, or coding standards) so Octopus reviews like a team member who actually read the docs
- **React to findings** with thumbs up/down on GitHub/Bitbucket so Octopus learns what matters to your team

Takes about 5 minutes to get everything running. Let us know if you need help.$forgejo_template$;

UPDATE "email_templates"
SET "body" = $forgejo_template$Hey {{firstName}},

You've got an Octopus account but haven't connected a repository yet. Without a repo, Octopus can't do its thing.

To get started:

- Open Settings → Integrations in Octopus
- Connect GitHub, GitLab, Bitbucket or your self-hosted Forgejo instance
- Enable automatic reviews for the repositories you want reviewed

For Forgejo, use an HTTPS instance and personal access token, then configure the repository webhook. Use self-hosted Octopus for private LAN/VPN instances. [Follow the setup guide]({{appUrl}}/docs/integrations#forgejo).

If you're running into issues or have questions, just reply to this email.$forgejo_template$,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'connect-repo-reminder'
  AND "system" = true
  AND "body" = $forgejo_template$Hey {{firstName}},

You've got an Octopus account but haven't connected a repository yet. Without a repo, Octopus can't do its thing.

Connecting takes less than a minute:

- Click "Add Repository" in the dashboard
- Pick a GitHub or Bitbucket repo
- That's it. Octopus will start reviewing your next PR automatically.

If you're running into issues or have questions, just reply to this email.$forgejo_template$;
