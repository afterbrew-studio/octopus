import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import type { Schemas } from "@qdrant/js-client-rest";
import { SupersededIndexError } from "@/lib/repository-index-completion";

export type RepositoryIndexOwner = { repoId: string; signal?: AbortSignal } & (
  { indexAttemptId: string; uploadId?: string } | { activeIndexGeneration: string | null }
);

type AttemptOwner = Extract<RepositoryIndexOwner, { indexAttemptId: string }>;

function attemptWhere(owner: AttemptOwner): Prisma.RepositoryWhereInput {
  return {
    id: owner.repoId, indexStatus: "indexing", indexAttemptId: owner.indexAttemptId,
    ...(owner.uploadId === undefined ? {} : { localIndexUpload: { path: ["id"], equals: owner.uploadId } }),
  };
}

/** Marks the attempt alive for crash recovery; throws once another attempt or a cancellation owns the row. */
export async function touchRepositoryIndex(owner: AttemptOwner): Promise<void> {
  owner.signal?.throwIfAborted();
  const touched = await prisma.repository.updateMany({ where: attemptWhere(owner), data: { updatedAt: new Date() } });
  if (!touched.count) throw new SupersededIndexError();
}

export async function getRepositoryIndexGeneration(owner: RepositoryIndexOwner): Promise<string | null> {
  owner.signal?.throwIfAborted();
  const current = await prisma.repository.findFirst({
    where: "indexAttemptId" in owner
      ? attemptWhere(owner)
      : { id: owner.repoId, indexStatus: "indexed", activeIndexGeneration: owner.activeIndexGeneration },
    select: { id: true },
  });
  if (!current) throw new SupersededIndexError();
  owner.signal?.throwIfAborted();
  return "indexAttemptId" in owner ? owner.uploadId ?? owner.indexAttemptId : owner.activeIndexGeneration;
}

export function repositoryCodeStorageId(repoId: string, generation: string | null): string {
  // Older binaries filter and delete solely by repoId. Keep generated indexes
  // outside that legacy key so rolling upgrades cannot expose or erase them.
  return generation === null ? repoId : JSON.stringify([repoId, generation]);
}

export function repositoryCodeFilter(repoId: string, generation: string | null): Schemas["Filter"] {
  return { must: [
    { key: "repoId", match: { value: repositoryCodeStorageId(repoId, generation) } },
    generation === null ? { is_empty: { key: "indexGeneration" } } : { key: "indexGeneration", match: { value: generation } },
  ] };
}

export async function getActiveRepositoryCodeFilter(repoIds: string[]): Promise<Schemas["Filter"] | null> {
  if (!repoIds.length) return null;
  const repos = await prisma.repository.findMany({
    where: { id: { in: repoIds } }, select: { id: true, activeIndexGeneration: true },
  });
  return repos.length ? { should: repos.map(repo => repositoryCodeFilter(repo.id, repo.activeIndexGeneration)) } : null;
}
