import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "@octopus/db";
import { requestViaForgejoConnector } from "@/lib/forgejo-connector";
import { decryptString } from "@/lib/crypto";
import { forgejoRequest, ForgejoHttpError, ForgejoResponseTooLargeError, normalizeForgejoHost } from "@/lib/forgejo-http";
import { attachReviewPatches, type ReviewInput, type ReviewFileInput } from "@/lib/review-coverage";
import { MAX_FETCH_DIFF_CHARS, truncateDiff } from "@/lib/diff-truncate";
import { reviewPublicationSignal, type ReviewExecutionWindow } from "@/lib/review-capacity";
import type { ReviewComment } from "@/lib/github";

type Credentials = { host: string; token?: string; integrationId?: string; connectorTokenHash?: string };
type RequestOptions = Parameters<typeof forgejoRequest>[3];
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const repositoryContext = new AsyncLocalStorage<{ organizationId: string; integrationId: string; host: string; username: string; connectorTokenHash?: string | null; expectedHead?: string | null }>();

/** A worker admitted for one instance must never adopt credentials from a
 * disconnected/replaced integration midway through a review or index job. */
export async function runWithForgejoRepository<T>(repoId: string, callback: () => Promise<T>, expectedHead?: string | null): Promise<T> {
  const repo = await prisma.repository.findUnique({ where: { id: repoId }, select: {
    provider: true, organizationId: true, isActive: true, dismissedAt: true, externalId: true,
    organization: { select: { bannedAt: true, deletedAt: true, forgejoIntegration: { select: { id: true, forgejoHost: true, username: true, connectorTokenHash: true } } } },
  } });
  const integration = repo?.organization.forgejoIntegration;
  if (!repo || repo.provider !== "forgejo" || !repo.isActive || repo.dismissedAt || !integration
    || repo.organization.bannedAt || repo.organization.deletedAt
    || !repo.externalId.startsWith(`${integration.forgejoHost}:`)
    || !/^\d+$/.test(repo.externalId.slice(integration.forgejoHost.length + 1))) {
    throw new Error("Forgejo repository is no longer connected to this instance");
  }
  const parent = repositoryContext.getStore();
  if (parent && (parent.organizationId !== repo.organizationId || parent.integrationId !== integration.id
    || parent.host !== integration.forgejoHost || parent.username !== integration.username || parent.connectorTokenHash !== integration.connectorTokenHash)) {
    throw new Error("Forgejo integration changed during the operation");
  }
  return repositoryContext.run({ organizationId: repo.organizationId, integrationId: integration.id,
    host: integration.forgejoHost, username: integration.username, connectorTokenHash: integration.connectorTokenHash, expectedHead: expectedHead ?? parent?.expectedHead }, callback);
}

export function usesForgejoConnector(): boolean {
  return !!repositoryContext.getStore()?.connectorTokenHash;
}

async function credentials(organizationId: string): Promise<Credentials> {
  const integration = await prisma.forgejoIntegration.findUnique({ where: { organizationId },
    include: { organization: { select: { bannedAt: true, deletedAt: true } } } });
  if (!integration) throw new Error("No Forgejo integration found for this organization");
  if (integration.organization.bannedAt || integration.organization.deletedAt) throw new Error("Forgejo organization is no longer active");
  const context = repositoryContext.getStore();
  if (context && (context.organizationId !== organizationId || context.integrationId !== integration.id
    || context.host !== integration.forgejoHost || context.username !== integration.username || context.connectorTokenHash !== integration.connectorTokenHash)) {
    throw new Error("Forgejo integration changed during the operation; retry from the connected repository");
  }
  if (integration.connectorTokenHash) {
    if (!integration.username) throw new Error("Start your Forgejo connector before syncing repositories");
    if (integration.connectorError) throw new Error(integration.connectorError);
    return { host: integration.forgejoHost, integrationId: integration.id, connectorTokenHash: integration.connectorTokenHash };
  }
  if (!integration.accessTokenEnc) throw new Error("Forgejo has no active credentials");
  return { host: integration.forgejoHost, token: decryptString(integration.accessTokenEnc) };
}

async function request(auth: Credentials, path: string, options?: RequestOptions) {
  if (auth.integrationId && auth.connectorTokenHash) {
    return requestViaForgejoConnector(auth.integrationId, auth.connectorTokenHash, path, options);
  }
  if (!auth.token) throw new Error("Forgejo has no active credentials");
  return forgejoRequest(auth.host, auth.token, path, options);
}

async function read<T>(auth: Credentials, path: string, options?: RequestOptions): Promise<T> {
  const response = await request(auth, `/api/v1${path}`, options);
  try { return JSON.parse(response.body) as T; } catch { throw new Error("Invalid Forgejo API response"); }
}

function repositoryPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some(part => !part || part === "." || part === ".." || /[\\\x00-\x1f]/.test(part))) {
    throw new Error("Invalid Forgejo repository name");
  }
  return `/repos/${parts.map(encodeURIComponent).join("/")}`;
}

function positiveId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid Forgejo resource ID");
  return value;
}

export interface ForgejoRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { admin?: boolean; push?: boolean };
  archived?: boolean;
}

export async function validateForgejoConnection(host: string, token: string): Promise<{ host: string; username: string }> {
  host = normalizeForgejoHost(host);
  const user = await read<{ login?: unknown }>({ host, token }, "/user");
  if (typeof user.login !== "string" || !user.login) throw new Error("Forgejo did not return an authenticated username");
  return { host, username: user.login };
}

export async function listUserRepos(organizationId: string): Promise<ForgejoRepository[]> {
  const auth = await credentials(organizationId);
  const repos: ForgejoRepository[] = [];
  const seen = new Set<number>();
  // Fail an oversized or changing listing rather than deactivating unseen repos.
  for (let page = 1; page <= 200; page++) {
    const entries = await read<ForgejoRepository[]>(auth, `/user/repos?limit=50&page=${page}&order_by=id`);
    if (!Array.isArray(entries)) throw new Error("Invalid Forgejo repository listing");
    if (entries.length === 0) return repos;
    for (const repo of entries) {
      positiveId(repo.id);
      if (typeof repo.full_name !== "string" || typeof repo.name !== "string") throw new Error("Invalid Forgejo repository entry");
      repositoryPath(repo.full_name);
      if (seen.has(repo.id)) throw new Error("Forgejo repository listing changed during sync; retry sync");
      seen.add(repo.id);
      repos.push(repo);
    }
  }
  throw new Error("Forgejo repository listing exceeds the sync limit");
}

type PullRequest = {
  number: number; title: string; html_url?: string; body?: string; user?: { login?: string };
  head?: { sha?: string }; base?: { sha?: string }; merge_base?: string; changed_files?: number;
  state?: string; draft?: boolean; merged?: boolean;
};

function revision(pr: PullRequest): { headSha: string; baseSha: string | null } {
  if (typeof pr.head?.sha !== "string" || !shaPattern.test(pr.head.sha)) throw new Error("Forgejo PR has no valid head revision");
  // Forgejo's diff is relative to merge_base, not the current target-branch head.
  const base = pr.merge_base;
  return { headSha: pr.head.sha, baseSha: typeof base === "string" && shaPattern.test(base) ? base : null };
}

export async function getPullRequestDetails(organizationId: string, fullName: string, prNumber: number, signal?: AbortSignal) {
  const auth = await credentials(organizationId);
  const pr = await read<PullRequest>(auth, `${repositoryPath(fullName)}/pulls/${positiveId(prNumber)}`, { signal });
  if (pr.number !== prNumber || typeof pr.title !== "string") throw new Error("Invalid Forgejo pull request response");
  return { number: pr.number, title: pr.title, url: `${auth.host}/${fullName}/pulls/${prNumber}`,
    author: pr.user?.login ?? "unknown", body: typeof pr.body === "string" ? pr.body : "", ...revision(pr),
    state: pr.state, draft: pr.draft === true, merged: pr.merged === true };
}

export async function getPullRequestReviewInput(organizationId: string, fullName: string, prNumber: number, expectedHead: string | null): Promise<{ input: ReviewInput; rawDiff: string }> {
  const auth = await credentials(organizationId);
  const path = `${repositoryPath(fullName)}/pulls/${positiveId(prNumber)}`;
  const before = await read<PullRequest>(auth, path);
  const { headSha, baseSha } = revision(before);
  if (expectedHead && expectedHead !== headSha) throw new Error("PR revision changed before review input was fetched");
  const expectedFiles = Number.isSafeInteger(before.changed_files) && before.changed_files! >= 0 ? before.changed_files! : null;
  const files: ReviewFileInput[] = [];
  const seen = new Set<string>();
  let exhausted = false;
  type ChangedFile = { filename: string; previous_filename?: string; status: string; additions?: number; deletions?: number };
  for (let page = 1; page <= 60; page++) {
    const response = await request(auth, `/api/v1${path}/files?limit=50&page=${page}`);
    let entries: ChangedFile[];
    try { entries = JSON.parse(response.body); } catch { throw new Error("Invalid Forgejo changed-file response"); }
    if (entries === null && expectedFiles === 0 && files.length === 0) entries = [];
    if (!Array.isArray(entries)) throw new Error("Invalid Forgejo changed-file response");
    for (const file of entries) {
      if (typeof file.filename !== "string" || !file.filename || seen.has(file.filename) || typeof file.status !== "string") {
        throw new Error("Invalid or repeated Forgejo changed-file entry");
      }
      seen.add(file.filename);
      files.push({ path: file.filename, previousPath: file.previous_filename || undefined,
        change: file.status === "deleted" ? "removed" : file.status === "changed" || file.status === "unchanged" ? "modified" : file.status,
        additions: Number.isSafeInteger(file.additions) && file.additions! >= 0 ? file.additions : undefined,
        deletions: Number.isSafeInteger(file.deletions) && file.deletions! >= 0 ? file.deletions : undefined });
    }
    if (entries.length === 0 || response.headers["x-hasmore"] === "false") { exhausted = true; break; }
  }
  let rawDiff = "";
  let diffLimited = false;
  try {
    const response = await request(auth, `/api/v1${path}.diff`, { maxBytes: Math.min(MAX_FETCH_DIFF_CHARS * 4, 16 * 1024 * 1024) });
    rawDiff = truncateDiff(response.body, MAX_FETCH_DIFF_CHARS);
    diffLimited = response.body.length > MAX_FETCH_DIFF_CHARS;
  } catch (error) {
    if (!(error instanceof ForgejoResponseTooLargeError)) throw error;
    diffLimited = true;
  }
  const after = await read<PullRequest>(auth, path);
  const current = revision(after);
  if (current.headSha !== headSha || current.baseSha !== baseSha || after.base?.sha !== before.base?.sha) {
    throw new Error("PR revision changed while review input was being fetched");
  }
  const inventoryComplete = exhausted && expectedFiles !== null && files.length === expectedFiles && Boolean(baseSha);
  const limitations = [
    ...(!inventoryComplete ? ["Forgejo changed-file inventory could not be verified completely."] : []),
    ...(diffLimited ? ["Forgejo diff exceeds the retained fetch budget."] : []),
  ];
  return { rawDiff, input: { provider: "forgejo", headSha, baseSha, expectedFiles, inventoryComplete,
    files: attachReviewPatches(files, rawDiff), limitations } };
}

export async function createPullRequestComment(organizationId: string, fullName: string, prNumber: number, body: string, executionWindow?: ReviewExecutionWindow): Promise<number> {
  const auth = await credentials(organizationId);
  const result = await read<{ id: number }>(auth, `${repositoryPath(fullName)}/issues/${positiveId(prNumber)}/comments`,
    { method: "POST", body: { body }, signal: reviewPublicationSignal(executionWindow) });
  return positiveId(result.id);
}

export async function updatePullRequestComment(organizationId: string, fullName: string, _prNumber: number, commentId: number, body: string, executionWindow?: ReviewExecutionWindow): Promise<void> {
  const auth = await credentials(organizationId);
  await request(auth, `/api/v1${repositoryPath(fullName)}/issues/comments/${positiveId(commentId)}`,
    { method: "PATCH", body: { body }, signal: reviewPublicationSignal(executionWindow) });
}

export async function createPullRequestReview(organizationId: string, fullName: string, prNumber: number, body: string,
  comments: ReviewComment[], executionWindow?: ReviewExecutionWindow): Promise<number> {
  const auth = await credentials(organizationId);
  const signal = reviewPublicationSignal(executionWindow);
  const details = await getPullRequestDetails(organizationId, fullName, prNumber, signal);
  const expectedHead = repositoryContext.getStore()?.expectedHead;
  if (expectedHead && details.headSha !== expectedHead) throw new Error("Forgejo PR revision changed before review publication");
  const result = await read<{ id: number }>(auth, `${repositoryPath(fullName)}/pulls/${positiveId(prNumber)}/reviews`, {
    method: "POST", signal, body: { body, event: "COMMENT", commit_id: expectedHead ?? details.headSha,
      comments: comments.map(comment => ({ path: comment.path, body: comment.body,
        new_position: comment.line, old_position: 0 })) },
  });
  return positiveId(result.id);
}

export async function createInlineComment(organizationId: string, fullName: string, prNumber: number, path: string, line: number, body: string, executionWindow?: ReviewExecutionWindow): Promise<number> {
  return createPullRequestReview(organizationId, fullName, prNumber, "", [{ path, line, body, side: "RIGHT" }], executionWindow);
}

export async function setCommitStatus(organizationId: string, fullName: string, sha: string,
  state: "running" | "success" | "failed" | "canceled", name: string, description: string, targetUrl?: string, executionWindow?: ReviewExecutionWindow): Promise<void> {
  if (!shaPattern.test(sha)) throw new Error("Invalid Forgejo commit revision");
  const auth = await credentials(organizationId);
  await read(auth, `${repositoryPath(fullName)}/statuses/${sha}`, { method: "POST", signal: reviewPublicationSignal(executionWindow),
    body: { state: { running: "pending", success: "success", failed: "failure", canceled: "error" }[state],
      context: name, description: description.slice(0, 255), ...(targetUrl ? { target_url: targetUrl } : {}) } });
}

export async function getBranchHead(organizationId: string, fullName: string, branch: string): Promise<string | null> {
  const auth = await credentials(organizationId);
  const result = await read<{ commit?: { id?: string } }>(auth, `${repositoryPath(fullName)}/branches/${encodeURIComponent(branch)}`);
  return result.commit?.id && shaPattern.test(result.commit.id) ? result.commit.id : null;
}

export async function getRepositoryTree(organizationId: string, fullName: string, branch: string): Promise<string[]> {
  const auth = await credentials(organizationId);
  const sha = shaPattern.test(branch) ? branch : await getBranchHead(organizationId, fullName, branch);
  if (!sha) throw new Error("Forgejo branch has no valid revision");
  const paths: string[] = [];
  const seen = new Set<string>();
  let expectedEntries: number | undefined;
  for (let page = 1; page <= 100; page++) {
    const data = await read<{ tree?: { path: string; type: string; mode?: string }[] | null; total_count?: number }>(auth,
      `${repositoryPath(fullName)}/git/trees/${sha}?recursive=true&per_page=1000&page=${page}`);
    if (!Number.isSafeInteger(data.total_count) || data.total_count! < 0
      || (expectedEntries !== undefined && expectedEntries !== data.total_count)) throw new Error("Invalid Forgejo tree count");
    expectedEntries = data.total_count;
    if (data.tree == null && expectedEntries === 0 && seen.size === 0) return [];
    if (!Array.isArray(data.tree)) throw new Error("Invalid Forgejo repository tree");
    for (const entry of data.tree) {
      if (typeof entry.path !== "string" || seen.has(entry.path)) throw new Error("Invalid or repeated Forgejo tree entry");
      seen.add(entry.path);
      if (entry.type === "blob" && entry.mode !== "120000") paths.push(entry.path);
    }
    // Forgejo versions can keep truncated=true on the final nonempty page.
    // Count every entry (including directories) against the immutable tree's total.
    if (seen.size === expectedEntries) return paths;
    if (seen.size > expectedEntries!) throw new Error("Forgejo tree exceeds its declared count");
    if (!data.tree.length) break;
  }
  throw new Error("Forgejo repository tree could not be fetched completely");
}

export async function getFileContent(organizationId: string, fullName: string, branch: string, filePath: string): Promise<string> {
  if (filePath.split("/").some(part => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(filePath)) throw new Error("Invalid Forgejo file path");
  const auth = await credentials(organizationId);
  try {
    const result = await read<{ type?: string; encoding?: string; content?: string }>(auth,
      `${repositoryPath(fullName)}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
      { maxBytes: 2 * 1024 * 1024 });
    if (result.type !== "file" || result.encoding !== "base64" || typeof result.content !== "string") {
      throw new Error("Forgejo did not return file content");
    }
    return Buffer.from(result.content, "base64").toString("utf8");
  } catch (error) {
    if (error instanceof ForgejoHttpError && error.status === 404) return "";
    throw error;
  }
}
