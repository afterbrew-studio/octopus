# Model discovery

On review-engine instances with `ENABLE_REVIEW_WORKERS=true`, pg-boss checks provider catalogs daily at 07:00 UTC. Discovery uses the instance's configured provider keys, not organization BYOK keys. The worker stores the latest snapshot in `SystemConfig.modelDiscovery`; it does not keep a history.

The authenticated admin endpoint `GET /api/admin/models/discover?cached=1` reads that snapshot without contacting providers. Before the first saved check it returns `checkedAt: null` and an empty `providers` object. Omitting `cached=1` runs an on-demand check and returns the result without updating the saved snapshot. Both responses disable HTTP caching. The vendor Models page and its Refresh control are maintained separately in `octopus-admin`.

Provider reads share a 15-second deadline across response bodies and pagination and also respect request or job cancellation. A failed provider returns a sanitized `error`; its empty result arrays must not be interpreted as an authoritative empty catalog. A missing key is reported as `keyConfigured: false`. The response's top-level `ok: true` does not mean every provider succeeded: consumers must inspect each provider's status and `checkedAt` for stale scheduling. Database failures can prevent a new snapshot from being saved.

Discovery does not enable models, change defaults, replace pins or send mail. Provider results are filtered and often lack prices and compatibility details. Review candidates before using the existing add-model controls; an upstream absence is a review signal, not an automatic retirement.

Claude Opus 5.5 (`claude-opus-5-5`) is an opt-in catalog entry. Select it in organization model settings or pin it for a repository; existing defaults and pins remain unchanged. The [catalog migration](../packages/db/prisma/migrations/20260925180000_opus55_and_model_discovery/migration.sql) seeds its input/output rates without overwriting an existing row. The catalog owns those rates; [cost.ts](../apps/web/lib/cost.ts) owns fallback pricing, cache factors and platform markup. Native JSON output uses `output_config.format` and adaptive thinking because forced tool selection is unsupported; earlier model behavior is unchanged.

Provider references:

- https://platform.claude.com/docs/en/models/opus-5-5/overview
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- https://www.anthropic.com/claude-opus-5-5

Claude Sonnet 5.5 (`claude-sonnet-5-5`) is also opt-in. Its [additive migration](../packages/db/prisma/migrations/20260929150000_sonnet55/migration.sql) seeds provider rates of $2 input / $10 output per million tokens, with no default or pin changes. Cache reads cost $0.20, five-minute writes $2.50 and one-hour writes $4 per million tokens before platform markup. These are the same input/output prices as Sonnet 5; lower cost per task is not a token-price reduction.

Sonnet 5.5 uses native JSON and adaptive thinking at Octopus's configured effort (medium by default). Explicit `thinking: "disabled"` maps to `between_tools`, which skips upfront thinking; `xhigh` and `max` effort are clamped to `high` only in that mode. The installed SDK predates this mode, so a narrow request type extension preserves all other SDK field checking. [Regression tests](../apps/web/lib/__tests__/sonnet55.test.ts) exercise serialized SDK requests with mocked responses. Enable the catalog entry only when compatible web and review workers are deployed; older adapters send unsupported thinking or forced-tool settings. A real provider request remains a release acceptance check.

- [Sonnet 5.5 specifications](https://platform.claude.com/docs/en/models/sonnet-5-5/overview)
- [Migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
- [Thinking modes](https://platform.claude.com/docs/en/build-with-claude/thinking)

For this additive-only Sonnet 5.5 release, deploy compatible code to all web and review-worker instances first and retire older instances before applying the catalog migration; coordinate the admin UI rollout with this sequence. The migration inserts Sonnet 5.5 as active, so applying it first would expose the model to incompatible v1.2.11 adapters. This code-first sequence is specific to this catalog-only migration, not a general rule for schema changes. Before rolling code back to older adapters, disable the Sonnet 5.5 catalog entry and ensure no selected, pinned, queued or in-flight Sonnet 5.5 review can reach those adapters; drain such work on compatible workers first. Do not leave Sonnet 5.5 selectable after a code rollback.

Offline regression coverage lives in [opus55.test.ts](../apps/web/lib/__tests__/opus55.test.ts), [cost.test.ts](../apps/web/lib/__tests__/cost.test.ts) and [model-discovery.test.ts](../apps/web/lib/__tests__/model-discovery.test.ts). For release acceptance, verify the actual catalog row, persisted scheduled check and authenticated cached response; a schedule declaration alone does not prove a completed discovery. The subscriber touchbase template is prepared separately in `octopus-admin`. Do not send it until release availability and the opted-in audience are verified and a send is authorized.
