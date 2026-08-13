/**
 * Per-member permission scopes on top of the owner/admin/member role model.
 *
 * Model: role gives a BASELINE set of scopes; OrganizationMember.scopes holds
 * ADDITIVE grants beyond that baseline (e.g. a "member" granted "repos:manage"
 * can connect repositories without becoming an admin). Grants are never
 * subtractive — a scope can only add what the role alone wouldn't allow.
 *
 * Format mirrors lib/scopes.ts (`resource:action`, deny-by-default, no
 * wildcards). This module is PURE (no prisma / server-only) so client
 * components can reuse it to hide UI the server would reject anyway.
 */

export const ORG_SCOPE_REGISTRY = {
  repos: ["manage"],
  reviews: ["configure"],
  members: ["manage"],
  billing: ["manage"],
  integrations: ["manage"],
  tokens: ["manage"],
  settings: ["manage"],
} as const;

export type OrgScope = {
  [R in keyof typeof ORG_SCOPE_REGISTRY]: `${R & string}:${(typeof ORG_SCOPE_REGISTRY)[R][number]}`;
}[keyof typeof ORG_SCOPE_REGISTRY];

export const ALL_ORG_SCOPES: OrgScope[] = Object.entries(ORG_SCOPE_REGISTRY).flatMap(
  ([resource, actions]) => actions.map((a) => `${resource}:${a}` as OrgScope),
);

export const ORG_SCOPE_LABELS: Record<OrgScope, string> = {
  "repos:manage": "Manage repositories",
  "reviews:configure": "Configure reviews",
  "members:manage": "Manage members",
  "billing:manage": "Manage billing",
  "integrations:manage": "Manage integrations",
  "tokens:manage": "Manage API tokens",
  "settings:manage": "Manage org settings",
};

/**
 * What each role can do WITHOUT explicit grants. Derived from the pre-scopes
 * role checks so rollout is behavior-identical: management surfaces were
 * admin+owner, so admins keep every scope; members had none.
 */
export const ROLE_BASELINE: Record<string, readonly OrgScope[]> = {
  owner: ALL_ORG_SCOPES,
  admin: ALL_ORG_SCOPES,
  member: [],
};

export type MemberPermissions = {
  role: string;
  scopes?: string[] | null;
};

/** Deny-by-default: true iff the role baseline or an explicit grant covers the scope. */
export function hasOrgPermission(
  member: MemberPermissions | null | undefined,
  scope: OrgScope,
): boolean {
  if (!member) return false;
  const baseline = ROLE_BASELINE[member.role] ?? [];
  if (baseline.includes(scope)) return true;
  return member.scopes?.includes(scope) ?? false;
}

/**
 * Validate + normalize a scope list at write time (admin console / owner
 * editor): trim/lowercase/dedupe, reject unknown scopes. An empty list is
 * VALID here (unlike token scopes) — it just means "role baseline only".
 */
export function normalizeOrgScopes(input: unknown): OrgScope[] {
  if (!Array.isArray(input)) throw new Error("scopes must be an array of strings");
  const cleaned = [
    ...new Set(input.map((s) => String(s).trim().toLowerCase()).filter(Boolean)),
  ];
  const unknown = cleaned.filter((s) => !(ALL_ORG_SCOPES as string[]).includes(s));
  if (unknown.length > 0) {
    throw new Error(
      `unknown scope(s): ${unknown.join(", ")}. Valid: ${ALL_ORG_SCOPES.join(", ")}`,
    );
  }
  return cleaned as OrgScope[];
}
