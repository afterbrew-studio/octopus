import "server-only";
import { prisma } from "@octopus/db";
import { getQdrantClient } from "@/lib/qdrant";

/**
 * One-off (but reusable) consolidation of two organizations into one: every
 * org-scoped record is re-pointed from the SOURCE org onto the TARGET org, the
 * credit balances are summed onto the target, the target is optionally renamed,
 * and the drained source is SOFT-deleted (deletedAt) — never hard-deleted, so
 * no destructive FK cascade fires (the product's own delete path is a soft
 * delete: apps/web/app/(app)/actions.ts).
 *
 * The Postgres side runs in a single interactive transaction; a dryRun executes
 * every statement then rolls back and returns the exact affected-row counts, so
 * the plan can be verified against real prod data with zero risk. The Qdrant
 * payload rewrite (vectors are filtered by an `orgId` payload, not an FK, so
 * they'd silently orphan otherwise) runs only on a real apply, after commit,
 * since Qdrant is not part of the SQL transaction.
 *
 * Table classification is verified against packages/db/prisma/schema.prisma.
 */

// Tables re-pointed by a plain `organizationId` UPDATE — they have no
// org-compound unique constraint that could collide when moving rows between
// these orgs. Repo-scoped data (e.g. code_chunks, pull_requests) moves with the
// repositories row and needs no separate re-point (repo ids are stable).
const PLAIN_MOVE_TABLES = [
  "repositories",
  "bitbucket_integrations",
  "gitlab_integrations",
  "slack_integrations",
  "collab_integrations",
  "linear_integrations",
  "jira_integrations",
  "knowledge_documents",
  "knowledge_audit_logs",
  "chat_conversations",
  "ai_usages",
  "credit_transactions",
  "package_analyses",
  "safe_package_requests",
  "package_deep_dives",
  "local_agents",
  "agent_llm_tasks",
  "agent_search_tasks",
  "audit_logs",
  "activity_events",
  "org_type_changes",
  "organization_invitations",
  "community_review_jobs",
  "auto_reload_configs",
] as const;

// Qdrant collections whose points are filtered by an `orgId` payload
// (apps/web/lib/qdrant.ts). `code_chunks` is `repoId`-keyed and needs no rewrite.
const QDRANT_ORG_COLLECTIONS = [
  "knowledge_chunks",
  "review_chunks",
  "chat_chunks",
  "flowchart_chunks",
  "feedback_patterns",
] as const;

export interface MergeOrgsParams {
  sourceOrgId: string;
  targetOrgId: string;
  /** Rename the surviving (target) org. */
  newName?: string;
  newSlug?: string;
  /** Revoke (soft-delete) the source org's API tokens instead of moving them,
   *  so they don't silently gain access to the target's repos. Default true. */
  revokeSourceTokens?: boolean;
  /** true = execute + roll back, returning counts only. false = commit. */
  dryRun: boolean;
}

class DryRunRollback extends Error {
  constructor(public report: MergeReport) {
    super("dry-run rollback");
  }
}

export interface MergeReport {
  dryRun: boolean;
  sourceOrgId: string;
  targetOrgId: string;
  source: { name: string; credit: string; free: string };
  target: {
    before: { credit: string; free: string };
    after: { name: string; slug: string; credit: string; free: string };
  };
  counts: Record<string, number>;
  qdrant?: Record<string, { points?: number; rewritten?: boolean; error?: string }>;
}

async function qdrantReport(
  sourceOrgId: string,
  targetOrgId: string,
  countOnly: boolean,
): Promise<MergeReport["qdrant"]> {
  const client = getQdrantClient();
  const filter = { must: [{ key: "orgId", match: { value: sourceOrgId } }] };
  const out: NonNullable<MergeReport["qdrant"]> = {};
  for (const c of QDRANT_ORG_COLLECTIONS) {
    try {
      const cnt = await client.count(c, { filter, exact: true });
      out[c] = { points: cnt.count, rewritten: false };
      if (!countOnly && cnt.count > 0) {
        await client.setPayload(c, { payload: { orgId: targetOrgId }, filter, wait: true });
        out[c].rewritten = true;
      }
    } catch (e) {
      // A missing collection (self-host / never-seeded) is not fatal.
      out[c] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

export async function mergeOrgs(params: MergeOrgsParams): Promise<MergeReport> {
  const {
    sourceOrgId,
    targetOrgId,
    newName,
    newSlug,
    revokeSourceTokens = true,
    dryRun,
  } = params;

  if (sourceOrgId === targetOrgId) {
    throw new Error("sourceOrgId and targetOrgId must differ");
  }

  let committed: MergeReport | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        const src = await tx.organization.findUnique({ where: { id: sourceOrgId } });
        const tgt = await tx.organization.findUnique({ where: { id: targetOrgId } });
        if (!src) throw new Error(`source org ${sourceOrgId} not found`);
        if (!tgt) throw new Error(`target org ${targetOrgId} not found`);
        if (src.deletedAt) throw new Error("source org is already deleted");
        if (tgt.deletedAt) throw new Error("target org is deleted");
        if (newSlug) {
          const clash = await tx.organization.findFirst({
            where: { slug: newSlug, NOT: { id: targetOrgId } },
          });
          if (clash) throw new Error(`slug "${newSlug}" already taken by org ${clash.id}`);
        }

        const counts: Record<string, number> = {};

        // Members: move source members not already in target (demoting any
        // owner to admin — the target keeps its own owner); then soft-close
        // any leftover source rows (a user already in the target), so no active
        // membership points at the drained org.
        counts.members_moved = await tx.$executeRaw`
          UPDATE organization_members
          SET "organizationId" = ${targetOrgId},
              role = CASE WHEN role = 'owner' THEN 'admin' ELSE role END
          WHERE "organizationId" = ${sourceOrgId}
            AND "userId" NOT IN (
              SELECT "userId" FROM organization_members WHERE "organizationId" = ${targetOrgId}
            )`;
        counts.members_closed = await tx.$executeRaw`
          UPDATE organization_members SET "deletedAt" = now()
          WHERE "organizationId" = ${sourceOrgId} AND "deletedAt" IS NULL`;

        // Compound-unique tables: drop source rows that would collide, move the rest.
        counts.day_summaries_dropped = await tx.$executeRaw`
          DELETE FROM day_summaries s
          WHERE s."organizationId" = ${sourceOrgId}
            AND EXISTS (SELECT 1 FROM day_summaries t
                        WHERE t."organizationId" = ${targetOrgId} AND t.date = s.date)`;
        counts.day_summaries_moved = await tx.$executeRaw`
          UPDATE day_summaries SET "organizationId" = ${targetOrgId} WHERE "organizationId" = ${sourceOrgId}`;

        // UserPresence is ephemeral heartbeat data — drop the source rows.
        counts.user_presences_dropped = await tx.$executeRaw`
          DELETE FROM user_presences WHERE "organizationId" = ${sourceOrgId}`;

        counts.incident_comms_dropped = await tx.$executeRaw`
          DELETE FROM incident_comms s
          WHERE s."organizationId" = ${sourceOrgId}
            AND EXISTS (SELECT 1 FROM incident_comms t
                        WHERE t."organizationId" = ${targetOrgId} AND t."incidentKey" = s."incidentKey")`;
        counts.incident_comms_moved = await tx.$executeRaw`
          UPDATE incident_comms SET "organizationId" = ${targetOrgId} WHERE "organizationId" = ${sourceOrgId}`;

        counts.coupon_redemptions_dropped = await tx.$executeRaw`
          DELETE FROM coupon_redemptions s
          WHERE s."organizationId" = ${sourceOrgId}
            AND EXISTS (SELECT 1 FROM coupon_redemptions t
                        WHERE t."organizationId" = ${targetOrgId} AND t."couponId" = s."couponId")`;
        counts.coupon_redemptions_moved = await tx.$executeRaw`
          UPDATE coupon_redemptions SET "organizationId" = ${targetOrgId} WHERE "organizationId" = ${sourceOrgId}`;

        // API tokens: revoke (default) so they can't silently reach target repos.
        if (revokeSourceTokens) {
          counts.org_api_tokens_revoked = await tx.$executeRaw`
            UPDATE org_api_tokens SET "deletedAt" = now()
            WHERE "organizationId" = ${sourceOrgId} AND "deletedAt" IS NULL`;
        } else {
          counts.org_api_tokens_moved = await tx.$executeRaw`
            UPDATE org_api_tokens SET "organizationId" = ${targetOrgId} WHERE "organizationId" = ${sourceOrgId}`;
        }

        // Plain re-point for every other org-scoped table.
        for (const table of PLAIN_MOVE_TABLES) {
          counts[table] = await tx.$executeRawUnsafe(
            `UPDATE "${table}" SET "organizationId" = $1 WHERE "organizationId" = $2`,
            targetOrgId,
            sourceOrgId,
          );
        }

        // Sum balances onto the target (atomic single UPDATE), then rename it,
        // then zero + soft-delete the source.
        await tx.$executeRaw`
          UPDATE organizations tgt
          SET "creditBalance" = tgt."creditBalance" + src."creditBalance",
              "freeCreditBalance" = tgt."freeCreditBalance" + src."freeCreditBalance"
          FROM organizations src
          WHERE tgt.id = ${targetOrgId} AND src.id = ${sourceOrgId}`;

        if (newName || newSlug) {
          await tx.organization.update({
            where: { id: targetOrgId },
            data: { ...(newName ? { name: newName } : {}), ...(newSlug ? { slug: newSlug } : {}) },
          });
        }

        await tx.$executeRaw`
          UPDATE organizations
          SET "creditBalance" = 0, "freeCreditBalance" = 0, "deletedAt" = now()
          WHERE id = ${sourceOrgId}`;

        const after = await tx.organization.findUniqueOrThrow({
          where: { id: targetOrgId },
          select: { name: true, slug: true, creditBalance: true, freeCreditBalance: true },
        });

        const report: MergeReport = {
          dryRun,
          sourceOrgId,
          targetOrgId,
          source: {
            name: src.name,
            credit: src.creditBalance.toString(),
            free: src.freeCreditBalance.toString(),
          },
          target: {
            before: { credit: tgt.creditBalance.toString(), free: tgt.freeCreditBalance.toString() },
            after: {
              name: after.name,
              slug: after.slug,
              credit: after.creditBalance.toString(),
              free: after.freeCreditBalance.toString(),
            },
          },
          counts,
        };

        if (dryRun) throw new DryRunRollback(report);
        committed = report;
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
  } catch (e) {
    if (e instanceof DryRunRollback) {
      return { ...e.report, qdrant: await qdrantReport(sourceOrgId, targetOrgId, true) };
    }
    throw e;
  }

  // Apply path only: rewrite Qdrant payloads after the DB commit.
  const qdrant = await qdrantReport(sourceOrgId, targetOrgId, false);
  return { ...(committed as MergeReport), qdrant };
}
