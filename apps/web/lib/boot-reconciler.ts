import { prisma } from "@octopus/db";
import { INDEX_SILENCE_LIMIT_MS } from "@/lib/index-liveness";

const STALE_ANALYSIS_MS = 10 * 60 * 1000;

export async function reconcileStaleRepoStates() {
  const indexCutoff = new Date(Date.now() - INDEX_SILENCE_LIMIT_MS);
  const analysisCutoff = new Date(Date.now() - STALE_ANALYSIS_MS);

  try {
    const indexing = await prisma.repository.updateMany({
      where: { indexStatus: "indexing", updatedAt: { lt: indexCutoff } },
      data: { indexStatus: "pending" },
    });
    const analyzing = await prisma.repository.updateMany({
      where: { analysisStatus: "analyzing", updatedAt: { lt: analysisCutoff } },
      data: { analysisStatus: "none" },
    });

    if (indexing.count || analyzing.count) {
      console.log(
        `[boot-reconciler] reset stale rows: indexing=${indexing.count} analyzing=${analyzing.count}`,
      );
    } else {
      console.log("[boot-reconciler] no stale rows to reset");
    }
  } catch (err) {
    console.error("[boot-reconciler] failed:", err);
  }
}
