# Forgejo connection content audit

Updated: 20 September 2026. Direct-integration baseline: v1.1.0, commit `85d94b190b25a681a0c289af7a94744b8ee4b3c8`.

This audit covers the repository's current website, onboarding emails, help content and machine-readable descriptions. It tracks the v1.2.0 connector changes separately from the direct Forgejo integration shipped in v1.1.0. Source changes and local validation do not establish a deployed release or a completed review against a user's Forgejo installation.

## The three connection paths

The [Forgejo setup chooser](https://octopus-review.ai/docs/integrations#forgejo) is the canonical entry point. It separates these paths before giving credentials or webhook instructions:

| Path | Forgejo access | Forgejo personal access token | Webhook destination |
| --- | --- | --- | --- |
| [Octopus Cloud + public HTTPS](https://octopus-review.ai/docs/integrations#forgejo-cloud-public) | Cloud connects directly to a public HTTPS origin | Encrypted in Octopus | Octopus Cloud |
| [Octopus Cloud + private LAN/VPN](https://octopus-review.ai/docs/integrations#forgejo-cloud-private) | Local connector polls Cloud outward and accesses its configured private HTTPS origin | Stays on the connector machine | Forgejo sends directly to Octopus Cloud over outbound HTTPS |
| [Self-hosted Octopus + private LAN/VPN](https://octopus-review.ai/docs/integrations#forgejo-self-hosted) | Web and review workers connect directly with matching routes, DNS and explicit allowed origins | Encrypted in the user's Octopus deployment | The user's Octopus deployment |

The Cloud connector opens no listener and needs no tunnel or public Forgejo URL. Both the connector and Forgejo need outbound HTTPS to Octopus Cloud. Container routing and DNS must work independently of access from the operator's browser. Cloud options send code and review context to Octopus Cloud and configured AI services. The connector does not keep review processing on the private network.

The [self-hosting guide](https://octopus-review.ai/docs/self-hosting#forgejo) owns direct private-network operator configuration. It links Cloud users back to the connector path. Native CLI agent onboarding remains GitHub-only.

## Current content inventory

| Surface | Source | Result |
| --- | --- | --- |
| Setup chooser and three separate instructions | `apps/web/app/(landing)/docs/integrations/page.tsx` | Named anchors, common bot/token prerequisites, actual runner environment and image, Cloud webhook destination, TLS/CA, status, rotation, disconnect and uncertain-write recovery. Shared review-event rules remain explicit. |
| Self-hosted operator guide | `apps/web/app/(landing)/docs/self-hosting/page.tsx` | Direct private access is clearly scoped to self-hosted Octopus; Cloud connector crosslink, origin allowlist, matching workers/DNS, trusted CA and private webhook target rules. |
| Homepage and repository introduction | `apps/web/app/(landing)/page.tsx`, `README.md` | Three connection options and setup links; no private hosting claim that implies local Cloud processing. |
| Dashboard onboarding | `apps/web/components/dashboard/providers-banner.tsx` | Names public direct, Cloud private connector and self-hosted direct access. |
| Settings | `apps/web/app/(app)/settings/integrations/forgejo-integration-card.tsx` | Direct and connector choices, setup link, one-time credential, connection state and management actions. |
| Quickstart and FAQ | `apps/web/app/(landing)/docs/getting-started/page.tsx`, `docs/faq/page.tsx` | Three paths; removes private-requires-selfhost claim and unrealistic two-minute setup promise. |
| Comparison FAQ | `apps/web/app/(landing)/vs-coderabbit/page.tsx`, `vs-greptile/page.tsx` | Octopus's three connection options. No new competitor capability claims. |
| Search | `apps/web/app/(landing)/docs/docs-search.tsx` | Includes private, LAN, VPN, connector, public and HTTPS keywords. |
| Public assistant and full LLM text | `apps/web/lib/docs-content.ts`, `apps/web/app/api/ask-octopus/route.ts`, generated `apps/web/app/llms-full.txt/route.ts` | Separate connection paths and actual connector setup; no self-host-only answer for Cloud private users. |
| LLM index | `apps/web/public/llms.txt` | Separate Cloud private and self-hosted direct links; clear Cloud processing statement. |
| Welcome, getting-started and reminder emails | `apps/web/lib/email-template-seeds.ts` | All three Forgejo options, chooser links and Cloud data-flow disclosure. |
| Existing email templates | `packages/db/prisma/migrations/20260919213000_forgejo_connector_email_templates/migration.sql` | Updates only exact v1.1.0 default system-template bodies. Custom content, sender, subject, enabled state and delivery preferences remain intact. No emails are sent. |
| Privacy, security and retention | `apps/web/app/(landing)/docs/privacy/page.tsx`, `docs/security-overview/page.tsx`, `docs/data-retention/page.tsx` | Distinguishes local Forgejo token from hashed connector credential; discloses encrypted transport storage, cleanup and backup limits. |
| Release notes | `CHANGELOG.md` | Customer-facing connector behavior and upgrade instructions in v1.2.0. Earlier release notes retain their dated scope. |
| Reviewed, no mode-specific change needed | `apps/web/app/layout.tsx`, `apps/web/lib/structured-data.ts`, login panel, about, glossary, GitHub Action related links, sub-processors, bug-bounty page | Existing provider lists remain accurate. GitHub-only features retain their scope. |

The token instructions account for Forgejo's scope restrictions: `read:user` is unavailable for Specific repositories tokens. A dedicated account limits access to intended repositories while the token uses All (public, private, and limited) with `read:user`, `write:repository` and `write:issue`. No instance administrator access is needed. See [Forgejo token scope documentation](https://forgejo.org/docs/latest/user/authentication/token-scope/).

For direct self-hosted Octopus webhooks on a private destination, Forgejo operators must preserve existing `ALLOWED_HOST_LIST` entries and add the specific target host. The Cloud connector's webhook destination is public Octopus Cloud and needs no private webhook target. See [Forgejo webhook configuration](https://forgejo.org/docs/latest/admin/config-cheat-sheet/#webhook-webhook).

## Release follow-through

For v1.2.2, the outer release executor owns the following steps. This is a web/docs patch with no new migrations or email-template changes; the setup commands retain the tested, published connector 1.2.0 image. Initial connector installation requirements belong to the [v1.2.0 release notes](../../CHANGELOG.md#120---2026-09-19).

1. Wait for all CI and image checks, then deploy only the exact verified web image digest. Preserve existing engine workers and configuration.
2. Keep the published connector command pin unchanged; the web version bump does not require a connector upgrade.
3. Refresh the assistant's indexed documentation using the existing authorized `POST /api/admin/seed-docs` process after deployment. Source updates and generated LLM text do not refresh Qdrant by themselves.
4. Check the live chooser, all three anchors, narrow layouts, Settings flow and shared self-hosting page. Do not send live customer emails to validate this change.
5. Verify live content and deployed provenance. The guide's end-to-end acceptance check remains an authorized private Forgejo repository completing indexing, a signed event, a review, comments and commit status; local browser QA and a successful webhook delivery alone do not establish that result.

## Validation recorded for this change

- The v1.2.2 guide clarifies that Docker downloads the connector, links its exact published package and Docker installation instructions, separates the Forgejo token from the Octopus connector token, and provides numbered setup steps with copyable commands. It links directly to integration settings, repositories and review logs. HTTPS, local-network access and Cloud processing requirements stay visible; certificate and recovery details are expandable. Indexed help content follows the same setup flow and must be reseeded after deployment. Shared code blocks provide visible, keyboard-accessible copy controls and success/failure feedback.
- Forgejo's webhook picker uses **Trigger on → Custom events… → Pull request events → Modification, Synchronized, Comments**; these UI labels differ from the `pull_request` and `issue_comment` wire events. The guide, integration card, indexed help and assistant prompt now use the picker labels. Confirmed against Forgejo v16.0.5's [webhook template](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/templates/webhook/shared-settings.tmpl#L104-L147) and [English labels](https://codeberg.org/forgejo/forgejo/src/tag/v16.0.5/options/locale/locale_en-US.ini#L2329-L2373). The guide also accounts for organization permissions, automatically started indexing and the existing Auto Review default.
- The release author's final local browser QA reports 21 passing checks at 1280, 390 and 320 CSS px across Integrations and the shared self-hosting page, including real clipboard writes, denied-copy feedback, keyboard focus, native details and links. Evidence and runnable scripts: `/Users/cem/.local/share/octopus/releases/v1.2.2/local-browser-qa`. Fresh Integrations navigation had no console errors. The unchanged self-hosting `EnvGenerator` hydration warning is recorded separately. This is supplied local evidence, not a deployment claim or a browser rerun during the documentation phase.
- The documentation phase ran the configured web ESLint command against all seven changed TypeScript files successfully; no formatter or lint fixes were needed.

### Earlier connector rollout evidence

The following records describe the original connector rollout, not new v1.2.2 migrations, email work or browser checks.

- Scoped ESLint passed for the edited landing, docs, assistant, dashboard and email files.
- The email migration-chain test passed against disposable PostgreSQL: 2 tests, 72 assertions. It runs both Forgejo email migrations twice, checks upgrades from pre-Forgejo and v1.1.0 defaults, matches the latest seeds, and preserves customized and non-system bodies, disabled delivery, sender and subject. The database was stopped afterward.
- Repeat the database check with `FORGEJO_EMAIL_TEST_DATABASE_URL=postgres://.../forgejo_email_test bun test apps/web/lib/__tests__/forgejo-email-migration.test.ts`. It requires a test-named database and uses a temporary table.
- All three email bodies rendered through the existing `renderEmailPreview` with a mocked database. No emails were sent. Local previews: `/tmp/octopus-forgejo-connector-welcome.html`, `/tmp/octopus-forgejo-connector-get-started-new-user.html`, `/tmp/octopus-forgejo-connector-connect-repo-reminder.html`.
- Real local Next.js docs at `http://localhost:43411` were browser-checked at 1280px and 390px. All three chooser links reached unique section anchors. The private setup and self-hosted guide had no page overflow; the latter linked Cloud users to the connector and rendered allowlist/CA instructions. Evidence: `/tmp/octopus-forgejo-connector-docs-{desktop,chooser-mobile,private-mobile,selfhost-mobile}.png`. Subsequent source edits removed the native Bun alternative, fixed one inline spacing issue, matched the UI labels and removed a pre-existing absolute self-host processing claim; repeat against the final release build.
- The welcome preview showed all three paths, the expected setup/dashboard/preferences links and a loaded logo at 1200px and a 390px narrow browser viewport without horizontal overflow. Screenshots: `/tmp/octopus-forgejo-connector-welcome-{desktop,narrow}.png`. This is rendered HTML validation, not inbox deliverability testing.
- Full application gates, final-build browser verification, actual connector behavior and deployment evidence belong to the release validation; this audit does not substitute for them.

## External content requiring separate follow-through

- The organization profile is owned by `octopusreview/.github`, `profile/README.md`; see [PR #4](https://github.com/octopusreview/.github/pull/4) for its Forgejo content update.
- Ads, social bios, pinned posts, sales templates and launch directories are not stored here. Their current content needs a separate account inventory. No campaigns or posts were changed.
- Blog bodies are database-backed, so a source scan is not a complete editorial inventory. Preserve dated posts and authentic GitHub example screenshots. A new Forgejo announcement or screenshot should match the verified release and actual review behavior.

For current onboarding and recovery instructions, use the [Forgejo setup guide](https://octopus-review.ai/docs/integrations#forgejo). The [data-retention policy](https://octopus-review.ai/docs/data-retention) owns connector payload and recovery-metadata retention details.
