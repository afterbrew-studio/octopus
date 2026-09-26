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

Apply the additive migration before starting the updated application and workers, then deploy the coordinated admin UI. Offline regression coverage lives in [opus55.test.ts](../apps/web/lib/__tests__/opus55.test.ts), [cost.test.ts](../apps/web/lib/__tests__/cost.test.ts) and [model-discovery.test.ts](../apps/web/lib/__tests__/model-discovery.test.ts). For release acceptance, verify the actual catalog row, persisted scheduled check and authenticated cached response; a schedule declaration alone does not prove a completed discovery. The subscriber touchbase template is prepared separately in `octopus-admin`. Do not send it until release availability and the opted-in audience are verified and a send is authorized.
