<p align="center">
  <img src="apps/web/public/brand/octopus-mark.png" width="72" alt="Octopus" />
</p>

# Octopus

AI code review for your pull requests. Get a review summary, severity-ranked findings and suggested fixes in GitHub, GitLab, Bitbucket or Forgejo.

**[Try Octopus Cloud](https://octopus-review.ai/login)** · **[Self-host Octopus](https://octopus-review.ai/docs/self-hosting)** · [Documentation](https://octopus-review.ai/docs)

<p>
  <a href="https://github.com/octopusreview/octopus/actions/workflows/ci.yml"><img src="https://github.com/octopusreview/octopus/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-Modified%20MIT-blue.svg" alt="License: Modified MIT" /></a>
  <a href="https://github.com/octopusreview/octopus/discussions"><img src="https://img.shields.io/github/discussions/octopusreview/octopus" alt="GitHub Discussions" /></a>
</p>

[![A real Octopus inline review finding with severity, explanation and a suggested code change](docs/screenshots/pr-finding.png)](https://github.com/octopusreview/octopus/pull/744#discussion_r3775719896)

*An actual inline finding from [public PR #744](https://github.com/octopusreview/octopus/pull/744#discussion_r3775719896). The [author confirmed the fix](https://github.com/octopusreview/octopus/pull/744#discussion_r3775726260). Captured 11 September 2026.*

## Choose your offering

| | Octopus Cloud | Octopus Self-hosted |
| --- | --- | --- |
| Hosting | Managed by Octopus. | Run on your own infrastructure. |
| Setup | Sign in, connect your code host and select repositories. | Deploy with Docker Compose, then configure your code host and AI providers. |
| Costs | Usage-based pricing; bring your own provider keys if preferred. | You cover hosting and AI provider costs. Source available under the [Modified MIT License](LICENSE.md). |
| Start here | [Cloud quickstart](https://octopus-review.ai/docs/getting-started) · [Pricing](https://octopus-review.ai/docs/pricing) | [Self-hosting guide](https://octopus-review.ai/docs/self-hosting) |

## Getting started

### Octopus Cloud

For GitHub projects, give your coding AI the [homepage setup prompt](https://octopus-review.ai/#agent-setup). It uses the native CLI to set up the repository in your current project; you approve sign-in and GitHub access. See the [CLI guide](https://octopus-review.ai/docs/cli) for installation and agent setup.

To set up through the dashboard instead:

1. [Sign in](https://octopus-review.ai/login) with Google, GitHub, Microsoft or an email magic link.
2. Create your organization, connect GitHub, GitLab, Bitbucket or Forgejo, and choose the repositories to review.
3. Follow the dashboard guide: confirm repository readiness, open a pull request or merge request, then wait for the first successfully published review. See the [first-review instructions](https://octopus-review.ai/docs/getting-started).

Forgejo has three connection options:

- [Octopus Cloud + public HTTPS](https://octopus-review.ai/docs/integrations#forgejo-cloud-public): connect directly with a personal access token.
- [Octopus Cloud + private LAN/VPN](https://octopus-review.ai/docs/integrations#forgejo-cloud-private): run the local connector on your network. It connects outward to Octopus Cloud; Forgejo stays private.
- [Self-hosted Octopus + private LAN/VPN](https://octopus-review.ai/docs/integrations#forgejo-self-hosted): connect directly from your own Octopus deployment with the explicit allowed origins.

All three use signed repository webhooks. Octopus and your configured AI services process code for reviews, including when a local connector is used. Hosting Forgejo yourself does not keep Cloud review processing on your network.

<p align="center">
  <a href="https://octopus-review.ai/login"><img src="docs/screenshots/cloud-sign-in.png" width="440" alt="The live Octopus Cloud sign-in screen, with Google, GitHub, Microsoft and email options" /></a>
</p>

*The real Cloud sign-in screen, captured 11 September 2026. See the [getting-started guide](https://octopus-review.ai/docs/getting-started) for the remaining setup steps.*

<a id="self-hosting-with-docker"></a>

### Octopus Self-hosted

Deploy Octopus on infrastructure you manage, with control over configuration and model providers. Follow the [self-hosting guide](https://octopus-review.ai/docs/self-hosting) for Docker Compose, environment setup and migrations, then configure your [GitHub App](https://octopus-review.ai/docs/github-app) or another [code-host integration](https://octopus-review.ai/docs/integrations).

## Features

- **Review where you work:** summaries, inline findings and suggested fixes in GitHub, GitLab, Bitbucket and Forgejo; [CLI reviews](https://octopus-review.ai/docs/cli) for terminal workflows.
- **Use your team's context:** indexed repository context, knowledge documents, and repo rules in `.octopus.md`, `AGENTS.md` or `CLAUDE.md`.
- **Choose your AI provider:** organization-level model settings and support for your own API keys. See [model discovery](docs/model-discovery.md) for catalog updates and [prompt caching](docs/prompt-caching.md) for switching, retention and accounting.
- **Understand the result:** severity levels, category scores and explicit [review coverage](docs/review-coverage.md), including incomplete results.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development and validation. Propose improvements in [GitHub Discussions](https://github.com/octopusreview/octopus/discussions), report bugs in [Issues](https://github.com/octopusreview/octopus/issues), or help with the [roadmap](ROADMAP.md).

## Roadmap

Follow [planned work](ROADMAP.md) and [shipped changes](https://octopus-review.ai/docs/changelog).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

Source available under the [Modified MIT License](LICENSE.md), including its commercial attribution condition.
