// Org member permission scopes now live in @octopus/db so octopus-admin can
// share the exact same registry (single source of truth). Re-exported here so
// existing `@/lib/org-permissions` imports keep working unchanged.
export * from "@octopus/db/org-permissions";
