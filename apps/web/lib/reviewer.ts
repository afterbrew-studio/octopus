import "server-only";
import crypto from "node:crypto";
import { prisma, type Prisma } from "@octopus/db";
import { pubby } from "@/lib/pubby";
import {
  searchSimilarChunks,
  searchKnowledgeChunks,
  ensureReviewCollection,
  upsertReviewChunks,
  deleteReviewChunksByPR,
  ensureDiagramCollection,
  upsertDiagramChunk,
  deleteDiagramChunksByPR,
  ensureFeedbackCollection,
  upsertFeedbackPattern,
  searchReviewChunks,
} from "@/lib/qdrant";
import { extractAllMermaidBlocks, extractNodeLabels, DIAGRAM_TYPE_LABELS } from "@/lib/mermaid-utils";
import { loadQueueConfig, computeStaleReclaimMs, enqueue } from "@/lib/queue";
import { createEmbeddings } from "@/lib/embeddings";
import { suppressFindingsFromFeedback } from "@/lib/feedback-suppression";
import { generateSparseVector } from "@/lib/sparse-vector";
import { substitutePromptVars } from "@/lib/prompt-substitute";
import { rerankDocuments } from "@/lib/reranker";
import { resolveReviewLanguage } from "@/lib/review-language";
import { findingSignature, mergeFindingsBySignature, inheritReviewIssueTriage } from "@/lib/finding-merge";
import { getAlwaysIncludeKnowledge, mergeKnowledgeChunks } from "@/lib/knowledge-context";
import {
  fetchRepoConfigFile,
  extractRepoConfigRules,
  buildRepoConfigUserBlock,
  normalizeRepoConfigFiles,
} from "@/lib/repo-config";
import {
  getPullRequestReviewInput as ghGetPullRequestReviewInput,
  getPullRequestDetails as ghGetPullRequestDetails,
  LargePrError,
  createPullRequestComment as ghCreatePullRequestComment,
  createPullRequestReview as ghCreatePullRequestReview,
  createSingleReviewComment as ghCreateSingleReviewComment,
  checkStateFor,
  createCheckRun as ghCreateCheckRun,
  updateCheckRun as ghUpdateCheckRun,
  getRepositoryTree as ghGetRepositoryTree,
  getFileContent as ghGetFileContent,
  listReviewComments as ghListReviewComments,
  listPullRequestReviewComments as ghListPullRequestReviewComments,
  listPullRequestIssueComments as ghListPullRequestIssueComments,
  listPullRequestReviews as ghListPullRequestReviews,
  getCommentReactions as ghGetCommentReactions,
  listOwnUnresolvedThreads,
  resolveReviewThread,
} from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";
import * as forgejo from "@/lib/forgejo";
import { getGithubAppConfig } from "@/lib/github-app-config";
import { parseOctopusIgnore, detectBadCommits } from "@/lib/octopus-ignore";
import { buildGeneratedMatcher } from "@/lib/generated-files";
import { MAX_DIFF_CHARS } from "@/lib/diff-truncate";
import { completeReviewCandidate, reviewCandidateSha256, assertReviewProcessingActive, ReviewProcessingExpiredError, type CompleteReviewAdmission, type ReviewExecutionWindow } from "@/lib/review-capacity";
import { confirmCompleteReviewCurrent } from "@/lib/review-capacity-current";
import { prepareReviewInput, applyReviewCoverage, coverageSummary, reviewCheckResult, reviewAssessmentComplete, type ReviewInput, type ReviewCoverage } from "@/lib/review-coverage";
import { prepareReviewComment } from "@/lib/review-comment-context";
import { createCoveredReviewRequest } from "@/lib/review-request";
import { canRestrictReviewToFollowUp } from "@/lib/review-follow-up";
import { prepareRecoveredReviewPresentation, prepareReviewPresentation, mapReviewPresentation, enforceReviewFindingsIntegrity, finalizeReviewPresentation } from "@/lib/review-presentation";
import { executeCoveredReview, executeFindingsRecovery, recordNoModelAssessment, markReviewAssessmentIncomplete } from "@/lib/review-assessment";
import { saveReviewAttempt, createReviewAttemptComment, withForgejoReviewPublication, recordFirstReviewCompletion } from "@/lib/review-attempt";
import { publishReviewSummary } from "@/lib/review-summary-comment";
import type { ReviewComment } from "@/lib/github";
import { eventBus } from "@/lib/events";
import { attemptOutcomeForStatus, resolveReviewConfig } from "@/lib/review-attempt";
import { DeferralEnqueueError } from "@/lib/review-deferral-error";
import { ClaimLostError, claimWhere, reserveClaim, updateUnderClaim, writeUnderClaim, WHILE_FINISHING, type ClaimIdentity } from "@/lib/review-claim";
import { submitVerdict } from "@/lib/review-verdict";
import { publicationCallTimeoutMs } from "@/lib/review-publication";
import {
  touchesSharedFiles,
  countFindings,
  countFindingsFromTable,
  parseDiffLines,
  sortAndCapFindings,
  buildLowSeveritySummary,
  stripDetailedFindings,
  buildInlineComments,
  mergeReviewConfigs,
  parseReviewConfig,
  MAX_FINDINGS_PER_REVIEW,
  extractCrossFileQueries,
  generateVerificationQueries,
  resolveIndexClaimWait,
  shouldFailReviewCheck,
  isCleanReview,
  mayApprove,
  assessmentVerified,
  readWholeDiff,
  assessChangeShape,
  formatPastReviews,
  formatPrIntent,
  buildRetrievalQuery,
  filterByConfidence,
  resolveConfidenceThreshold,
} from "@/lib/review-helpers";
import { selectRulePacks } from "@/lib/rulepacks";
import { toolPrePassEnabled, runSemgrepPrePass, formatToolFindings, filterToChangedLines } from "@/lib/deterministic-tools";
import type { ReviewConfig } from "@/lib/review-helpers";
import {
  gatherCrossFileContext,
  gatherVerificationContext,
  validateFindings,
  type FileContentFetcher,
} from "@/lib/review-validation";
import { indexRepository } from "@/lib/indexer";
import {
  type PriorFinding,
  FINDINGS_START_MARKER,
  FINDINGS_END_MARKER,
  extractDiffFiles,
  parseFindings,
  extractKeywords,
  deduplicateAgainstPrior,
  parseFindingsFromSummaryTable,
} from "@/lib/review-dedup";
import type { LogLevel } from "@/lib/indexer";
import { ensureRepositoryAnalysis, deferReviewForRepository } from "@/lib/review-repository-preparation";
import { writeSyncLog, deleteSyncLogs } from "@/lib/elasticsearch";
import { logAiUsage } from "@/lib/ai-usage";
import { resolveReviewModel } from "@/lib/review-routing";
import { createAiMessage, getProviderForModel } from "@/lib/ai-router";
import { getOrgSpendLimitStatus, shouldGuardConcurrency } from "@/lib/cost";
import fs from "node:fs";
import path from "node:path";

// Load system prompt template once (with diagram rules injected)
let systemPromptTemplate: string | null = null;
let conflictDetectionTemplate: string | null = null;

function getSystemPrompt(): string {
  if (!systemPromptTemplate) {
    const promptsDir = path.join(process.cwd(), "prompts");
    let template = fs.readFileSync(path.join(promptsDir, "SYSTEM_PROMPT.md"), "utf-8");
    const diagramRules = fs.readFileSync(path.join(promptsDir, "DIAGRAM_RULES.md"), "utf-8");
    template = template.replace("{{DIAGRAM_RULES}}", diagramRules);
    systemPromptTemplate = template;
  }
  return systemPromptTemplate;
}

function getConflictDetectionPrompt(): string {
  if (!conflictDetectionTemplate) {
    const promptsDir = path.join(process.cwd(), "prompts");
    conflictDetectionTemplate = fs.readFileSync(path.join(promptsDir, "CONFLICT_DETECTION.md"), "utf-8");
  }
  return conflictDetectionTemplate;
}

type ReviewEvent = {
  repoId: string;
  pullRequestId: string;
  headSha: string | null;
  reviewRequestVersion: number;
  number: number;
  status: "reviewing" | "completed" | "failed";
  step:
    | "started"
    | "fetching-diff"
    | "searching-context"
    | "generating-review"
    | "posting-comment"
    | "delegating-large-pr"
    | "completed"
    | "failed";
  detail?: string;
  error?: string;
};

async function emitReviewStatus(orgId: string, event: ReviewEvent) {
  const current = await prisma.pullRequest.findUnique({ where: { id: event.pullRequestId }, select: { headSha: true, reviewRequestVersion: true } });
  if (!event.headSha || current?.headSha !== event.headSha || current.reviewRequestVersion !== event.reviewRequestVersion) return false;
  await pubby
    .trigger(`presence-org-${orgId}`, "review-status", event)
    .catch((err) =>
      console.error("[reviewer] Pubby trigger failed:", err),
    );
  return true;
}

// --- Pre-review feedback sync helpers ---

// --- LLM-based reply intent classification ---

const FEEDBACK_CLASSIFICATION_MODEL = "claude-sonnet-5";

// GitLab commit-status context name — the merge-gating check GitLab MRs can
// require. Kept as one constant so every finalize path uses the same name
// (GitLab keys statuses by name; a mismatch would leave a stale "running" one).
const COMMIT_STATUS_NAME = "octopus";

type ReplyIntent = "dismissed" | "accepted" | "unclear";

/**
 * Quick emoji-only check. Returns a definitive intent if the reply is just
 * an emoji reaction, or null if LLM classification is needed.
 */
function checkEmojiIntent(body: string): ReplyIntent | null {
  const stripped = body.trim();
  if (/^(👎|:-1:)$/.test(stripped)) return "dismissed";
  if (/^(👍|:\+1:)$/.test(stripped)) return "accepted";
  // Emoji present alongside text — still check but don't short-circuit
  if (/👎|:-1:/.test(stripped) && stripped.length < 10) return "dismissed";
  if (/👍|:\+1:/.test(stripped) && stripped.length < 10) return "accepted";
  return null;
}

/**
 * Classify one or more author replies to a code review finding using a lightweight LLM call.
 * Each entry pairs the finding context with the author's reply text.
 * Returns one intent per entry, in the same order.
 *
 * On LLM failure, falls back to "unclear" for all entries.
 */
async function classifyReplyIntents(
  entries: { findingTitle: string; replyText: string }[],
  orgId: string,
): Promise<ReplyIntent[]> {
  if (entries.length === 0) return [];

  // Fast path: if all entries resolve via emoji, skip the LLM call entirely
  const emojiResults = entries.map((e) => checkEmojiIntent(e.replyText));
  if (emojiResults.every((r) => r !== null)) return emojiResults as ReplyIntent[];

  // Build a batch prompt — one entry per line, ask for JSON array response
  const lines = entries.map((e, i) =>
    `[${i}] Finding: "${e.findingTitle}" | Reply: "${e.replyText.slice(0, 500)}"`,
  );

  const systemPrompt = `You classify author replies to automated code review comments.
For each numbered entry, determine the author's intent:
- "dismissed": The author disagrees with the finding, says it's a false positive, explains why it's fine as-is, or otherwise rejects the suggestion.
- "accepted": The author agrees with the finding and indicates they will fix it, or thanks the reviewer for catching it.
- "unclear": The reply doesn't clearly indicate agreement or disagreement, or is ambiguous.

Reply ONLY with a JSON array of strings, one per entry, in order. Example: ["dismissed","accepted","unclear"]`;

  const userMessage = lines.join("\n");

  try {
    const response = await createAiMessage(
      {
        model: FEEDBACK_CLASSIFICATION_MODEL,
        maxTokens: 256,
        thinking: "disabled",
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      },
      orgId,
    );

    await logAiUsage({
      provider: response.provider,
      usedOwnKey: response.usedOwnKey,
      model: FEEDBACK_CLASSIFICATION_MODEL,
      operation: "feedback-classification",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
      organizationId: orgId,
    });

    // Parse the JSON array from the response
    const match = response.text.match(/\[[\s\S]*\]/);
    if (!match) {
      console.warn("[reviewer] LLM reply classification returned no JSON array, falling back to unclear");
      return entries.map(() => "unclear");
    }

    const parsed = JSON.parse(match[0]) as string[];
    const validIntents = new Set<string>(["dismissed", "accepted", "unclear"]);

    return entries.map((_, i) => {
      const val = parsed[i];
      return validIntents.has(val) ? (val as ReplyIntent) : "unclear";
    });
  } catch (err) {
    console.error("[reviewer] LLM reply classification failed, falling back to unclear:", err);
    return entries.map(() => "unclear");
  }
}

/**
 * Normalize a finding title for fuzzy matching.
 * Strips severity emojis, backtick contents, and collapses whitespace.
 */
function normalizeFindingTitle(title: string): string {
  return title
    .replace(/[🔴🟠🟡🔵💡]/g, "")
    .replace(/`[^`]+`/g, "...")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Extract significant keywords from a finding title/description for dedup matching.
 * Removes common stop words and returns a set of meaningful tokens.
 */
// extractKeywords, jaccardSimilarity, PriorFinding, deduplicateAgainstPrior,
// parseFindingsFromSummaryTable — imported from @/lib/review-dedup

/**
 * Parse per-finding feedback from a structured comment body.
 * Recognizes lines like:
 *   - 🟡 **Finding title** — 👍 Explanation
 *   - 🔵 **Finding title** — 👎 Reason
 *
 * Returns null if the comment doesn't contain per-finding feedback format.
 */
function parsePerFindingFeedback(body: string): { title: string; feedback: "up" | "down" }[] | null {
  const lines = body.split("\n");
  const results: { title: string; feedback: "up" | "down" }[] = [];

  for (const line of lines) {
    // Match lines with bold title and 👍/👎 feedback
    const titleMatch = line.match(/\*\*(.+?)\*\*/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    // Check the part after the title for feedback signals
    const afterTitle = line.slice(line.indexOf(titleMatch[0]) + titleMatch[0].length);

    // Check for emoji-based feedback signals in structured per-finding comments
    if (/👎|:-1:/.test(afterTitle)) {
      results.push({ title, feedback: "down" });
    } else if (/👍|:\+1:/.test(afterTitle)) {
      results.push({ title, feedback: "up" });
    }
  }

  return results.length > 0 ? results : null;
}

async function embedFeedbackPattern(
  issue: { id: string; title: string; description: string; severity: string; pullRequest: { repositoryId: string; repository: { organizationId: string } } },
  feedback: "up" | "down",
) {
  await ensureFeedbackCollection();
  const text = `${issue.title} ${issue.description}`;
  const [vector] = await createEmbeddings([text], {
    organizationId: issue.pullRequest.repository.organizationId,
    operation: "embedding",
  });
  await upsertFeedbackPattern({
    id: issue.id,
    vector,
    sparseVector: generateSparseVector(text),
    payload: {
      title: issue.title,
      description: issue.description,
      severity: issue.severity,
      feedback,
      repoId: issue.pullRequest.repositoryId,
      orgId: issue.pullRequest.repository.organizationId,
    },
  });
}

/**
 * Sync GitHub reactions (👍/👎) on previous review comments before re-review.
 * Scoped to a single PR for speed.
 */
async function syncReactionsForPR(
  installationId: number,
  owner: string,
  repoName: string,
  pullRequestId: string,
  headSha: string | null,
  reviewRequestVersion: number,
) {
  const issues = await prisma.reviewIssue.findMany({
    where: {
      pullRequestId,
      githubCommentId: { not: null },
      feedback: null,
    },
    select: {
      id: true,
      title: true,
      description: true,
      severity: true,
      githubCommentId: true,
      pullRequest: {
        select: {
          repositoryId: true,
          repository: { select: { organizationId: true } },
        },
      },
    },
  });

  if (issues.length === 0) return;

  let synced = 0;
  for (const issue of issues) {
    const commentId = Number(issue.githubCommentId);
    if (isNaN(commentId)) continue;

    try {
      const reactions = await ghGetCommentReactions(installationId, owner, repoName, commentId);
      if (reactions.thumbsUp > 0 || reactions.thumbsDown > 0) {
        const vote = reactions.thumbsUp >= reactions.thumbsDown ? "up" : "down";
        await prisma.reviewIssue.updateMany({
          where: { id: issue.id, pullRequest: { headSha, reviewRequestVersion } },
          data: { feedback: vote, feedbackAt: new Date(), feedbackBy: "github-reaction" },
        });
        await embedFeedbackPattern(issue, vote);
        synced++;
      }
    } catch (err) {
      console.error(`[reviewer] Failed to sync reaction for issue ${issue.id}:`, err);
    }
  }

  if (synced > 0) {
    console.log(`[reviewer] Synced ${synced} GitHub reactions for PR ${pullRequestId}`);
  }
}

/**
 * Scan reply comments on previous review inline comments for dismissal/acceptance signals.
 * Uses an LLM call (Haiku) to classify author intent — handles nuanced replies that
 * simple pattern matching would miss. Emoji-only replies (👍/👎) are fast-pathed
 * without an LLM call.
 *
 * Also scans general PR issue comments for per-finding feedback (lines like
 * "**Title** — 👎 reason" or "**Title** — 👍 addressed"). Falls back to bulk
 * dismiss if no per-finding format is detected but LLM classifies as dismissal.
 */
async function syncTextDismissalsForPR(
  installationId: number,
  owner: string,
  repoName: string,
  prNumber: number,
  pullRequestId: string,
  prAuthor: string,
  headSha: string | null,
  reviewRequestVersion: number,
) {
  const issues = await prisma.reviewIssue.findMany({
    where: {
      pullRequestId,
      feedback: null,
    },
    select: {
      id: true,
      title: true,
      description: true,
      severity: true,
      createdAt: true,
      githubCommentId: true,
      pullRequest: {
        select: {
          repositoryId: true,
          repository: { select: { organizationId: true } },
        },
      },
    },
  });

  if (issues.length === 0) return;

  let synced = 0;
  const dismissedIds = new Set<string>();

  // --- Part 1: Scan inline review comment replies (threaded dismissals) ---
  const issuesWithCommentId = issues.filter((i) => i.githubCommentId !== null);
  if (issuesWithCommentId.length > 0) {
    const allReviewComments = await ghListPullRequestReviewComments(installationId, owner, repoName, prNumber);

    // Build map: parent comment ID → reply bodies (only from PR author, not from the bot)
    const repliesByParent = new Map<number, { body: string; isAuthor: boolean }[]>();
    for (const comment of allReviewComments) {
      if (comment.inReplyToId) {
        const replies = repliesByParent.get(comment.inReplyToId) ?? [];
        replies.push({ body: comment.body, isAuthor: comment.user === prAuthor });
        repliesByParent.set(comment.inReplyToId, replies);
      }
    }

    // Collect issues that have replies, so we can batch-classify them via LLM
    const issuesToClassify: {
      issue: typeof issuesWithCommentId[number];
      replyText: string;
    }[] = [];

    for (const issue of issuesWithCommentId) {
      const commentId = Number(issue.githubCommentId);
      if (isNaN(commentId)) continue;

      const replies = repliesByParent.get(commentId);
      if (!replies || replies.length === 0) continue;

      // Combine all reply bodies for classification context
      const combinedReply = replies.map((r) => r.body).join("\n---\n");
      issuesToClassify.push({ issue, replyText: combinedReply });
    }

    if (issuesToClassify.length > 0) {
      const orgId = issuesToClassify[0].issue.pullRequest.repository.organizationId;
      const intents = await classifyReplyIntents(
        issuesToClassify.map((e) => ({
          findingTitle: e.issue.title,
          replyText: e.replyText,
        })),
        orgId,
      );

      for (let i = 0; i < issuesToClassify.length; i++) {
        const intent = intents[i];
        if (intent === "unclear") continue;

        const { issue } = issuesToClassify[i];
        const vote = intent === "dismissed" ? "down" : "up";
        const feedbackSource = intent === "dismissed" ? "github-reply-dismissal" : "github-reply-acceptance";
        try {
          await prisma.reviewIssue.updateMany({
            where: { id: issue.id, pullRequest: { headSha, reviewRequestVersion } },
            data: { feedback: vote, feedbackAt: new Date(), feedbackBy: feedbackSource },
          });
          await embedFeedbackPattern(issue, vote);
          dismissedIds.add(issue.id);
          synced++;
        } catch (err) {
          console.error(`[reviewer] Failed to record text feedback for issue ${issue.id}:`, err);
        }
      }
    }
  }

  // --- Part 2: Scan general PR issue comments for per-finding or bulk feedback ---
  // Supports two modes:
  // (a) Per-finding: comment has lines like "**Title** — 👎 reason" → match to specific findings
  // (b) Bulk dismiss: comment has dismissal keywords but no per-finding format → dismiss ALL
  const remainingIssues = issues.filter((i) => !dismissedIds.has(i.id));

  if (remainingIssues.length > 0) {
    const issueComments = await ghListPullRequestIssueComments(installationId, owner, repoName, prNumber);

    // Only consider comments from the PR author, posted AFTER the findings were created
    const oldestFinding = remainingIssues.reduce(
      (min, i) => (i.createdAt < min ? i.createdAt : min),
      remainingIssues[0].createdAt,
    );
    const relevantComments = issueComments.filter(
      (c) => c.user === prAuthor && new Date(c.createdAt) > oldestFinding,
    );

    // Build normalized title → issue mapping for per-finding matching
    const issuesByNormalizedTitle = new Map<string, typeof remainingIssues>();
    for (const issue of remainingIssues) {
      const key = normalizeFindingTitle(issue.title);
      const existing = issuesByNormalizedTitle.get(key) ?? [];
      existing.push(issue);
      issuesByNormalizedTitle.set(key, existing);
    }

    const bulkDismissComments: typeof relevantComments = [];

    for (const comment of relevantComments) {
      const perFinding = parsePerFindingFeedback(comment.body);

      if (perFinding) {
        // Per-finding mode: match each feedback line to specific findings
        for (const { title, feedback } of perFinding) {
          const normalizedTitle = normalizeFindingTitle(title);
          const matched = issuesByNormalizedTitle.get(normalizedTitle);
          if (!matched) continue;

          for (const issue of matched) {
            if (dismissedIds.has(issue.id)) continue;
            try {
              await prisma.reviewIssue.updateMany({
                where: { id: issue.id, pullRequest: { headSha, reviewRequestVersion } },
                data: { feedback, feedbackAt: new Date(), feedbackBy: "github-issue-comment-per-finding" },
              });
              await embedFeedbackPattern(issue, feedback);
              dismissedIds.add(issue.id);
              synced++;
            } catch (err) {
              console.error(`[reviewer] Failed to record per-finding feedback for issue ${issue.id}:`, err);
            }
          }
        }
      } else {
        // No per-finding format — candidate for bulk dismiss
        bulkDismissComments.push(comment);
      }
    }

    // Fallback: bulk dismiss for comments that didn't have per-finding format
    {
      const stillRemaining = remainingIssues.filter((i) => !dismissedIds.has(i.id));

      // Classify bulk comments via LLM to detect dismissal intent
      let hasDismissalComment = false;
      if (bulkDismissComments.length > 0 && stillRemaining.length > 0) {
        const orgId = stillRemaining[0].pullRequest.repository.organizationId;
        const intents = await classifyReplyIntents(
          bulkDismissComments.map((c) => ({
            findingTitle: "(all findings)",
            replyText: c.body,
          })),
          orgId,
        );
        hasDismissalComment = intents.some((i) => i === "dismissed");
      }

      if (hasDismissalComment && stillRemaining.length > 0) {
        const remainingIds = stillRemaining.map((i) => i.id);
        const { count } = await prisma.reviewIssue.updateMany({
          where: { id: { in: remainingIds }, pullRequest: { headSha, reviewRequestVersion } },
          data: { feedback: "down", feedbackAt: new Date(), feedbackBy: "github-issue-comment-dismissal" },
        });
        synced += count;

        for (const issue of stillRemaining) {
          try {
            await embedFeedbackPattern(issue, "down");
          } catch (err) {
            console.error(`[reviewer] Failed to embed feedback pattern for issue ${issue.id}:`, err);
          }
        }
        console.log(`[reviewer] Dismissed ${count} findings via bulk issue comment dismissal`);
      }
    }
  }

  if (synced > 0) {
    console.log(`[reviewer] Synced ${synced} text dismissals for PR ${pullRequestId}`);
  }
}

/**
 * Execute a review, and record what happened to its run.
 *
 * The lifecycle lives here rather than inside `processReviewInternal` because
 * that function has around a dozen exits and one of them is always the one
 * somebody forgets. `attemptOutcomeForStatus` reads the outcome off the pull
 * request afterwards, so a new exit inherits the behaviour instead of needing
 * to opt into it.
 *
 * @param reviewRunId The frozen `ReviewRun` to execute. When present its
 * configuration snapshot is used verbatim instead of re-merging system,
 * organization and repository config -- so a change to any of those between
 * enqueue and execution cannot alter the review that runs. rayf P-0007 C3.
 * Absent for jobs enqueued before runs existed; those keep the old behaviour
 * rather than failing, because refusing them would strand work already in the
 * queue. Distinct from the per-execution `attemptId` generated inside
 * `processReviewInternal`, which addresses the immutable `ReviewAttempt`
 * evidence record this run will (or will not) end up producing.
 */
export async function processReview(
  pullRequestId: string,
  executionWindow?: ReviewExecutionWindow,
  reviewRunId?: string,
): Promise<void> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId }, select: { headSha: true, reviewRequestVersion: true, repository: { select: { id: true, provider: true } } },
  });

  const dispatch = (): Promise<ReviewInternalOutcome> => {
    if (pr?.repository.provider === "forgejo") {
      return forgejo.runWithForgejoRepository(pr.repository.id, () => {
        if (!forgejo.usesForgejoConnector()) return processReviewInternal(pullRequestId, reviewRunId, executionWindow, pr);
        return withForgejoReviewPublication(
          pullRequestId, pr.headSha, pr.reviewRequestVersion,
          () => processReviewInternal(pullRequestId, reviewRunId, executionWindow, pr), executionWindow?.signal,
        );
      }, pr.headSha);
    }
    return processReviewInternal(pullRequestId, reviewRunId, executionWindow);
  };

  if (!reviewRunId) { await dispatch(); return; }

  // A run is acquired by one execution at a time: the conditional `pending` ->
  // `running` transition is won by exactly one of any number of overlapping jobs.
  // An execution that misses it neither dispatches nor finalizes: the run is
  // either held by the one that won, or finished, and in both cases it is not this
  // execution's to touch. A deferral hands the run back to `pending` before it
  // schedules the retry, so only that retry can take it again.
  const acquired = await prisma.reviewRun.updateMany({
    where: { id: reviewRunId, state: "pending", terminalAt: null },
    data: { state: "running" },
  });
  if (!acquired.count) {
    console.log(`[reviewer] Run ${reviewRunId} is held or finished; skipping this job for PR ${pullRequestId}`);
    return;
  }

  let dispatchOutcome: ReviewInternalOutcome;
  try {
    dispatchOutcome = await dispatch();
  } catch (err) {
    // A deferral that could not schedule its retry leaves the pull request pending
    // and the run alive, for the queue's retry and the reconciler to recover.
    if (!(err instanceof DeferralEnqueueError)) await finalizeAttempt(reviewRunId, "failed", `review threw: ${String(err)}`);
    throw err;
  }
  // A deferral re-enqueues the same run to retry once its prerequisite is
  // ready -- it never stopped, so it is not finalized here. A superseded run
  // already finalized itself inside `processReviewInternal`, before this
  // execution's pull-request read below would find someone else's request.
  if (dispatchOutcome === "deferred" || dispatchOutcome === "superseded" || dispatchOutcome === "lost") return;

  const finished = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: { status: true },
  });
  const outcome = attemptOutcomeForStatus(finished?.status);
  if (outcome) await finalizeAttempt(reviewRunId, outcome.state, outcome.detail);
}

/** Written once. The `terminalAt` guard is what makes that true under a race. */
async function finalizeAttempt(
  reviewRunId: string,
  state: "succeeded" | "failed" | "cancelled" | "superseded",
  detail: string,
): Promise<void> {
  await prisma.reviewRun.updateMany({
    where: { id: reviewRunId, terminalAt: null },
    data: { state, terminalAt: new Date(), terminalDetail: detail },
  });
}

/**
 * `reviewRequestVersion` is a new column: a run frozen before it existed
 * records `null` for it, not "bound to a version that happens to be null" --
 * that field is unbound, and a live value merely differing from `null` is
 * not a mismatch, or every run queued before this column's deploy would
 * supersede on its very first (and only) execution.
 *
 * `headSha` gets no such wildcard. It predates this run-binding check
 * entirely -- a run with no recorded head is one `webhook-shared.ts` never
 * threaded a head through at all, which is unsafe to treat as "whatever head
 * is current": that is the wrong-head defect this check exists to close, not
 * an exemption from it. A run with a NULL head is always treated as
 * mismatched, not compared away.
 */
function runBindingMismatch(
  run: { headSha: string | null; reviewRequestVersion: number | null },
  headSha: string | null,
  reviewRequestVersion: number,
): boolean {
  if (run.headSha === null) return true;
  if (run.headSha !== headSha) return true;
  return run.reviewRequestVersion !== null && run.reviewRequestVersion !== reviewRequestVersion;
}

/**
 * `"deferred"` marks the two exits that re-enqueue the same run to retry once
 * a prerequisite (indexing, analysis) is ready. `"superseded"` marks an
 * execution that found its run already finalized that way itself (the
 * run-binding check, or a deferral whose guarded update missed because the
 * pull request moved) -- `processReview` must not try to finalize it again
 * from the pull request's status, which by then belongs to a different
 * request. `"lost"` marks an execution whose claim was taken from it while it
 * deferred: the row and the run belong to whoever holds them now, so neither is
 * written. Every other `return` really is the run finishing without
 * executing (paused, blocked, already completed by this same run on a
 * replayed job), which the pull request's status already answers correctly.
 */
type ReviewInternalOutcome = "deferred" | "superseded" | "lost" | undefined;

async function processReviewInternal(pullRequestId: string, reviewRunId?: string, executionWindow?: ReviewExecutionWindow, expected?: { headSha: string | null; reviewRequestVersion: number }): Promise<ReviewInternalOutcome> {
  // Load PR with repo and org info
  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    include: {
      repository: {
        include: { organization: true },
      },
    },
  });

  if (!pr) {
    console.error(`[reviewer] PullRequest not found: ${pullRequestId}`);
    return;
  }

  if (expected && (pr.headSha !== expected.headSha || pr.reviewRequestVersion !== expected.reviewRequestVersion)) return;

  // A frozen run is bound to the exact request it was frozen for -- its head
  // SHA and request version, recorded at freeze time. An execution that finds
  // the pull request has since moved to a different request (a newer one was
  // admitted, e.g. while this one was deferred) must not claim, review or
  // publish anything under the OLD request's configuration: this run
  // finalizes as superseded here, before touching the pull request at all, so
  // the newer request's own job can claim it untouched.
  const reviewRun = reviewRunId
    ? await prisma.reviewRun.findUnique({
        where: { id: reviewRunId },
        select: { id: true, configSnapshot: true, state: true, headSha: true, reviewRequestVersion: true, terminalAt: true },
      })
    : null;
  if (reviewRun?.terminalAt) return;
  if (reviewRun && runBindingMismatch(reviewRun, pr.headSha, pr.reviewRequestVersion)) {
    await finalizeAttempt(
      reviewRunId!,
      "superseded",
      `pull request moved to headSha=${pr.headSha ?? "null"} version=${pr.reviewRequestVersion} before this run (frozen for headSha=${reviewRun.headSha ?? "null"} version=${reviewRun.reviewRequestVersion}) executed`,
    );
    return "superseded";
  }

  // `deferReviewForRepository`'s own guarded update can miss for the same
  // reason: the pull request moved between this function's own top-of-function
  // read and the defer attempt (its prerequisite check can be slow -- a real
  // AI summarization/analysis call). A miss means this run never actually
  // deferred, so it must not be reported "deferred" (which would leave it
  // non-terminal forever with nothing left to retry it); it is superseded.
  const finalizeSupersededDefer = async (): Promise<ReviewInternalOutcome> => {
    // A miss is also what losing the claim looks like, and then the row still holds
    // this run's own request: another execution of it is live, and finalizing the
    // run here would end that one too.
    const current = await prisma.pullRequest.findUnique({ where: { id: pullRequestId }, select: { headSha: true, reviewRequestVersion: true } });
    if (current && current.headSha === pr.headSha && current.reviewRequestVersion === pr.reviewRequestVersion) return "lost";
    if (reviewRunId) {
      await finalizeAttempt(reviewRunId, "superseded", "pull request moved before repository preparation could defer this run");
    }
    return "superseded";
  };

  // Guard against duplicate processing (e.g. pg-boss jobs replicated to standby DB,
  // or webhook retries). Use atomic UPDATE with WHERE to claim the review — only one
  // server can win. "reviewing" is NOT in the fresh-claim list because that would let
  // a second worker match an in-flight review and both would post comments. Stuck
  // reviews are recovered via a separate stale-claim path keyed on updatedAt.
  const serverId = process.env.OCTOPUS_SERVER_ID || "unknown";
  if (pr.status === "completed") {
    console.log(`[reviewer] PR ${pullRequestId} already completed, skipping`);
    return;
  }
  // Stale threshold must exceed the pg-boss job timeout so we don't race
  // with a still-running worker that pg-boss is about to kill for timing out.
  // Two windows: the in-process reviewer's timeout for status='reviewing',
  // and the longer internal-cli timeout for status='queued' (large-PR jobs
  // sit in 'queued' for the full clone+claude duration).
  const queueConfig = await loadQueueConfig();
  const reviewingStale = new Date(Date.now() - computeStaleReclaimMs(queueConfig.reviewTimeoutSeconds));
  const queuedStale = new Date(Date.now() - computeStaleReclaimMs(queueConfig.largeReviewTimeoutSeconds));
  // One execution's identity. Compared before this worker publishes anything or
  // writes a terminal status; see `claimToken` in the schema.
  const claimToken = crypto.randomUUID();
  // A bound run's claim can only take the exact request it was frozen for --
  // not merely whatever the pull request looked like when this function
  // started. Between the binding check above and this claim, a newer request
  // can land (e.g. the moment this worker picks up a replayed job); without
  // this, the claim below would go through using the earlier, now-stale
  // snapshot and this run would review someone else's request.
  const claimHeadSha = reviewRun ? (reviewRun.headSha ?? pr.headSha) : pr.headSha;
  const claimReviewRequestVersion = reviewRun ? (reviewRun.reviewRequestVersion ?? pr.reviewRequestVersion) : pr.reviewRequestVersion;
  const claimed = await prisma.pullRequest.updateMany({
    where: {
      id: pullRequestId,
      headSha: claimHeadSha,
      reviewRequestVersion: claimReviewRequestVersion,
      OR: [
        // Fresh-claim: never seen / explicitly retryable
        { status: "pending" },
        { status: "failed" },
        // Locked-claim: in-flight reviews block re-claim until their stale window passes.
        // This prevents webhook retries from double-processing a PR that's still being
        // reviewed (or whose internal-cli clone+claude is still running).
        { status: "reviewing", updatedAt: { lt: reviewingStale } },
        { status: "queued", updatedAt: { lt: queuedStale } },
      ],
    },
    data: { status: "reviewing", updatedAt: new Date(), claimToken },
  });
  if (claimed.count === 0) {
    // A bound run's claim just missed. That is either a genuinely in-flight
    // review of the SAME request (the ordinary case below), or the request
    // moved in the narrow window between the binding check and this claim --
    // only the latter is superseded, so a fresh read decides which.
    if (reviewRunId && reviewRun) {
      const current = await prisma.pullRequest.findUnique({
        where: { id: pullRequestId },
        select: { headSha: true, reviewRequestVersion: true },
      });
      if (current && runBindingMismatch(reviewRun, current.headSha, current.reviewRequestVersion)) {
        await finalizeAttempt(
          reviewRunId,
          "superseded",
          `pull request moved to headSha=${current.headSha ?? "null"} version=${current.reviewRequestVersion} between this run's binding check and its claim (frozen for headSha=${reviewRun.headSha ?? "null"} version=${reviewRun.reviewRequestVersion})`,
        );
        return "superseded";
      }
    }
    console.log(`[reviewer] PR ${pullRequestId} already claimed by another server, skipping on '${serverId}'`);
    return;
  }
  console.log(`[reviewer] PR ${pullRequestId} claimed by server '${serverId}'`);
  // Every write this execution makes to the row is conditioned on this identity.
  const claim: ClaimIdentity = { pullRequestId, claimToken, headSha: claimHeadSha, reviewRequestVersion: claimReviewRequestVersion };

  const repo = pr.repository;
  const org = repo.organization;
  const attemptId = crypto.randomUUID();
  let adaptiveProcessingWindow: ReviewExecutionWindow | undefined;
  let attemptCoverage: ReviewCoverage | undefined;
  let attemptSaved = false;

  // 3-tier config: system defaults -> org defaults -> repo overrides
  // The frozen decision, if this job carries one -- already loaded above,
  // alongside the run-binding check. Distinct from `attemptId` above: that
  // addresses the immutable `ReviewAttempt` evidence record this execution
  // will produce, not the frozen `ReviewRun` it was dispatched with.
  let systemConfig: ReviewConfig = {};
  try {
    const sysRow = await prisma.systemConfig.findUnique({ where: { id: "singleton" } });
    if (sysRow) systemConfig = parseReviewConfig(sysRow.defaultReviewConfig);
  } catch { /* table may not exist yet */ }
  const orgConfig = parseReviewConfig(org.defaultReviewConfig);
  const repoConfig = parseReviewConfig(repo.reviewConfig);
  // The snapshot wins. Re-merging here is what C3 exists to prevent: the three
  // sources are mutable, so the merge would answer "what is configured now"
  // rather than "what was approved when this was enqueued".
  const reviewConfig = resolveReviewConfig(reviewRun, mergeReviewConfigs(systemConfig, orgConfig, repoConfig));

  if (org.reviewsPaused) {
    console.log(`[reviewer] Reviews paused for org ${org.id}, skipping PR ${pr.id}`);
    return;
  }

  const isGitHub = repo.provider === "github";
  const isBitbucket = repo.provider === "bitbucket";
  const isGitlab = repo.provider === "gitlab";
  const isForgejo = repo.provider === "forgejo";
  const isForgejoConnector = isForgejo && forgejo.usesForgejoConnector();
  const usesProjectApi = isGitlab || isForgejo;
  const projectProvider = isForgejo ? forgejo : gitlab;
  const installationId = repo.installationId ?? org.githubInstallationId;

  if (isGitHub && !installationId) {
    console.error(`[reviewer] No GitHub installation for repo: ${repo.id}`);
    return;
  }

  // For GitHub & Bitbucket: workspace/repo. For GitLab: full path with namespace
  // (which can contain subgroups, so the simple split is only used by github/bitbucket).
  const [owner, repoName] = repo.fullName.split("/");
  const projectPath = repo.fullName;

  // Reviewing a red build spends a model call on a diff that is about to change:
  // the findings go stale the moment the author pushes the fix, and on a
  // fix-and-re-review loop that is the common case rather than the exception.
  //
  // Only a KNOWN failure holds. `pending` and `null` (nothing reported, or the
  // read failed) do not: a reviewer that waits for evidence it may never receive
  // stops reviewing altogether, which is a worse failure than an early read.
  if (org.reviewOnlyWhenCiPasses && isGitHub && installationId && pr.headSha) {
    const state = await checkStateFor(installationId, owner, repoName, pr.headSha).catch(() => null);
    if (state === "failing") {
      console.log(
        `[reviewer] PR ${pr.number} has failing checks at ${pr.headSha.slice(0, 8)}; not reviewing yet`,
      );
      // Released, not failed: the change is fine, the build is not finished
      // with it. The next trigger claims it again.
      await updateUnderClaim(claim, { status: "pending", claimToken: null }).catch(() => {});
      return;
    }
  }

  // Provider-aware helper functions
  const providerGetInput = (prNumber: number) =>
    isGitHub
      ? ghGetPullRequestReviewInput(installationId!, owner, repoName, prNumber, pr.headSha)
      : usesProjectApi
        ? projectProvider.getPullRequestReviewInput(org.id, projectPath, prNumber, pr.headSha)
        : bitbucket.getPullRequestReviewInput(org.id, owner, repoName, prNumber, pr.headSha);

  // PR description/body — used only to give the reviewer the change's intent.
  // Best-effort: never block a review if the metadata fetch fails.
  const providerGetPrBody = async (prNumber: number): Promise<string> => {
    try {
      const details = isGitHub
        ? await ghGetPullRequestDetails(installationId!, owner, repoName, prNumber)
        : usesProjectApi
          ? await projectProvider.getPullRequestDetails(org.id, projectPath, prNumber)
          : await bitbucket.getPullRequestDetails(org.id, owner, repoName, prNumber);
      return details.body ?? "";
    } catch (err) {
      console.warn(`[reviewer] Could not fetch PR body for intent:`, err);
      return "";
    }
  };

  const attemptLabel = (id = attemptId) => `Review attempt: ${id}. Head: ${pr.headSha ?? "unknown"}.\n\n`;
  const providerCreateComment = (prNumber: number, body: string, publishedAttemptId = attemptId, publicationWindow?: ReviewExecutionWindow) =>
    isGitHub
      ? ghCreatePullRequestComment(installationId!, owner, repoName, prNumber, attemptLabel(publishedAttemptId) + body)
      : usesProjectApi
        ? projectProvider.createPullRequestComment(org.id, projectPath, prNumber, attemptLabel(publishedAttemptId) + body, publicationWindow)
        : bitbucket.createPullRequestComment(org.id, owner, repoName, prNumber, attemptLabel(publishedAttemptId) + body, publicationWindow);

  const publishMainComment = (body: string, expectedReviewBody?: string, publishedAttemptId = attemptId, publicationWindow?: ReviewExecutionWindow) => isGitHub
    ? publishReviewSummary({ pullRequestId: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion,
      installationId: installationId!, owner, repo: repoName, prNumber: pr.number, body: attemptLabel(publishedAttemptId) + body, expectedReviewBody, executionWindow: publicationWindow, claim })
    : createReviewAttemptComment(pr.id, pr.headSha, pr.reviewRequestVersion, () => providerCreateComment(pr.number, body, publishedAttemptId, publicationWindow), undefined, claim);

  const providerUpdateComment = async (commentId: number, body: string, publishedAttemptId = attemptId, publicationWindow?: ReviewExecutionWindow) => {
    if (isGitHub) {
      reviewCommentId = await publishMainComment(body, undefined, publishedAttemptId, publicationWindow);
      return;
    }
    try {
      if (usesProjectApi) {
        await projectProvider.updatePullRequestComment(org.id, projectPath, pr.number, commentId, attemptLabel(publishedAttemptId) + body, publicationWindow);
      } else {
        await bitbucket.updatePullRequestComment(org.id, owner, repoName, pr.number, commentId, attemptLabel(publishedAttemptId) + body, publicationWindow);
      }
    } catch (err) {
      // If the comment was deleted externally, create a new one and update the reference
      if (err instanceof Error && err.message.includes("404")) {
        console.warn(`[reviewer] Comment ${commentId} not found (deleted?), creating new comment`);
        const newId = await publishMainComment(body, undefined, publishedAttemptId, publicationWindow);
        reviewCommentId = newId;
        return;
      }
      throw err;
    }
  };

  const providerGetTree = (branch: string) =>
    isGitHub
      ? ghGetRepositoryTree(installationId!, owner, repoName, branch)
      : usesProjectApi
        ? projectProvider.getRepositoryTree(org.id, projectPath, branch)
        : bitbucket.getRepositoryTree(org.id, owner, repoName, branch);

  // Cheap HEAD-SHA lookup used to validate the cached file tree. GitHub returns
  // the whole tree in one request, so caching it saves nothing — only Bitbucket
  // (one request per directory) and GitLab (paginated walk) benefit.
  const providerGetBranchHead = (branch: string): Promise<string | null> =>
    isBitbucket
      ? bitbucket.getBranchHead(org.id, owner, repoName, branch)
      : usesProjectApi
        ? projectProvider.getBranchHead(org.id, projectPath, branch)
        : Promise.resolve(null);

  // Walk the repo tree, but reuse a cached copy when the branch HEAD hasn't
  // moved since we last walked it. The full walk floods provider rate limits
  // (see [bitbucket] getRepositoryTree), so we trade it for a single HEAD-SHA
  // request on every review where the tree is unchanged.
  const getRepoTreeCached = async (branch: string): Promise<string[]> => {
    if (isGitHub) return providerGetTree(branch);

    let headSha: string | null = null;
    try {
      headSha = await providerGetBranchHead(branch);
    } catch (err) {
      console.warn("[reviewer] Failed to fetch branch head, skipping tree cache:", err);
    }

    if (
      headSha &&
      repo.treeSha === headSha &&
      Array.isArray(repo.treePaths) &&
      repo.treePaths.every((p) => typeof p === "string")
    ) {
      const cached = repo.treePaths as string[];
      console.log(`[reviewer] Tree cache hit for ${repo.fullName}@${headSha.slice(0, 8)} (${cached.length} files)`);
      return cached;
    }

    const paths = await providerGetTree(branch);

    // Only persist when we know which commit the tree belongs to — otherwise a
    // future HEAD-SHA lookup could match a stale cache it never validated.
    if (headSha) {
      try {
        await prisma.repository.update({
          where: { id: repo.id },
          data: { treeSha: headSha, treePaths: paths },
        });
        console.log(`[reviewer] Tree cache stored for ${repo.fullName}@${headSha.slice(0, 8)} (${paths.length} files)`);
      } catch (err) {
        console.warn("[reviewer] Failed to persist tree cache:", err);
      }
    }
    return paths;
  };
  let reviewCommentId: number | null = null;
  const baseEvent = {
    repoId: repo.id,
    pullRequestId: pr.id,
    headSha: pr.headSha,
    reviewRequestVersion: pr.reviewRequestVersion,
    number: pr.number,
  };

  // Create check run if we have a head SHA (GitHub only — Bitbucket has no checks API)
  let checkRunId: number | null = null;
  if (pr.headSha && isGitHub && installationId) {
    try {
      checkRunId = await ghCreateCheckRun(
        installationId,
        owner,
        repoName,
        pr.headSha,
        "Octopus Review",
      );
      console.log(`[reviewer] Check run created — id: ${checkRunId}`);

      // Clear permission flag if it was previously set
      if (org.needsPermissionGrant) {
        await prisma.organization.update({
          where: { id: org.id },
          data: { needsPermissionGrant: false },
        });
        console.log(`[reviewer] Permission grant flag cleared for org: ${org.id}`);
      }
    } catch (err) {
      console.error("[reviewer] Failed to create check run:", err);

      // 403 means the GitHub App needs new permissions accepted
      if (err instanceof Error && err.message.includes("403")) {
        await prisma.organization.update({
          where: { id: org.id },
          data: { needsPermissionGrant: true },
        }).catch((e) => console.error("[reviewer] Failed to set permission flag:", e));
        console.warn(`[reviewer] Permission grant needed for org: ${org.id}`);
      }
    }
  }

  // GitLab / Forgejo: post a running commit status so the MR shows the review in flight.
  // This is the merge-gating primitive — a project can require the "octopus"
  // status to pass before merge. Best-effort; a status failure never blocks the
  // review itself.
  if (pr.headSha && usesProjectApi && !isForgejoConnector) {
    await projectProvider
      .setCommitStatus(org.id, projectPath, pr.headSha, "running", COMMIT_STATUS_NAME, "Octopus review in progress")
      .catch((err) => console.error("[reviewer] Failed to set provider running status:", err));
  }

  // Pre-review: sync feedback from GitHub before generating new findings
  if (isGitHub && installationId) {
    try {
      await syncReactionsForPR(installationId, owner, repoName, pr.id, pr.headSha, pr.reviewRequestVersion);
      await syncTextDismissalsForPR(installationId, owner, repoName, pr.number, pr.id, pr.author, pr.headSha, pr.reviewRequestVersion);
    } catch (err) {
      console.warn("[reviewer] Pre-review feedback sync failed, continuing:", err);
    }
  }

  try {
    if (!isForgejoConnector) reviewCommentId = await publishMainComment("> 🐙 **Octopus Review** — Preparing review...");
    // Phase 0: Ensure the repository is indexed before preparing review context
    if (repo.indexStatus !== "indexed") {
      console.log(`[reviewer] Repository ${repo.fullName} not indexed (status: ${repo.indexStatus}). Starting auto-index...`);

      // Atomic claim: only one process can transition to "indexing" at a time.
      // If another process is already indexing, wait for it to finish instead of starting a parallel index.
      const claimResult = await prisma.repository.updateMany({
        where: { id: repo.id, indexStatus: { notIn: ["indexed", "indexing"] } },
        data: { indexStatus: "indexing" },
      });
      let shouldRunIndexing = claimResult.count > 0;

      // ── Yield path: another process is already indexing ──
      // Instead of blocking this worker with a poll loop, re-queue the PR
      // so pg-boss retries after the peer finishes indexing.
      if (!shouldRunIndexing) {
        const fresh = await prisma.repository.findUnique({ where: { id: repo.id }, select: { indexStatus: true } });
        const currentStatus = fresh?.indexStatus ?? "failed";

        if (currentStatus === "indexed") {
          // Peer already finished -- continue to the analysis prerequisite
          console.log(`[reviewer] Repository ${repo.fullName} already indexed by another process, continuing with review`);
          if (reviewCommentId) {
            await providerUpdateComment(
              reviewCommentId,
              "> 🐙 **Octopus Review** — Repository already indexed ✓.\n>\n> Preparing repository analysis...",
            );
          }
        } else if (currentStatus === "indexing") {
          // Peer still running -- yield this worker and retry later
          console.log(`[reviewer] Repository ${repo.fullName} is being indexed by another process, re-queuing PR ${pullRequestId}`);
          if (reviewCommentId) {
            await providerUpdateComment(
              reviewCommentId,
              "> 🐙 **Octopus Review** — Repository indexing is in progress.\n>\n> This review has been re-queued and will start automatically once indexing completes.",
            );
          }
          if (await deferReviewForRepository(pullRequestId, pr.headSha, pr.reviewRequestVersion, reviewRunId, claim)) return "deferred";
          return finalizeSupersededDefer();
        } else {
          // Peer failed -- attempt conditional reclaim
          const reclaimed = await prisma.repository.updateMany({
            where: { id: repo.id, indexStatus: { notIn: ["indexed", "indexing"] } },
            data: { indexStatus: "indexing" },
          });
          let finalCheckStatus: string | null = null;
          if (reclaimed.count === 0) {
            const finalCheck = await prisma.repository.findUnique({ where: { id: repo.id }, select: { indexStatus: true } });
            finalCheckStatus = finalCheck?.indexStatus ?? null;
          }
          const decision = resolveIndexClaimWait(currentStatus, reclaimed.count, finalCheckStatus);
          if (decision.action === "run-indexing") {
            console.log(`[reviewer] Repository ${repo.fullName} reclaimed indexing after peer failure`);
            shouldRunIndexing = true;
          } else if (decision.action === "skip-to-review") {
            console.log(`[reviewer] Repository ${repo.fullName} indexing resolved by peer, continuing with review`);
          } else {
            console.error(`[reviewer] Repository ${repo.fullName} ${decision.reason}`);
            await writeUnderClaim(claim, { status: "failed" });
            if (reviewCommentId) {
              await providerUpdateComment(
                reviewCommentId,
                "> 🐙 **Octopus Review** — Repository indexing failed and could not be recovered.\n>\n> Please re-trigger the review by commenting `@octopusreview`.",
              );
            }
            // Terminal — the review won't run, so finalize the GitLab status
            // (leaving "running" would strand the MR).
            if (pr.headSha && usesProjectApi) {
              await projectProvider
                .setCommitStatus(org.id, projectPath, pr.headSha, "failed", COMMIT_STATUS_NAME, "Repository indexing failed.")
                .catch((e) => console.error("[reviewer] Failed to set provider status:", e));
            }
            return;
          }
        }
      }

      // ── Run indexing (only if we hold the claim) ──
      if (shouldRunIndexing) {
        if (reviewCommentId) {
          await providerUpdateComment(
            reviewCommentId,
            "> 🐙 **Octopus Review** — This repository hasn't been indexed yet.\n>\n> Indexing in progress... this may take a few minutes. (Step 1/3)",
          );
        }

        const indexChannel = `presence-org-${org.id}`;
        await deleteSyncLogs(org.id, repo.id);

        pubby.trigger(indexChannel, "index-status", {
          repoId: repo.id,
          status: "indexing",
        }).catch((err) => console.error("[reviewer] Pubby index-status trigger failed:", err));

        const emitIndexLog = (message: string, level: LogLevel = "info") => {
          const timestamp = Date.now();
          pubby.trigger(indexChannel, "index-log", {
            repoId: repo.id,
            message,
            level,
            timestamp,
          }).catch((err) => console.error("[reviewer] Pubby index-log trigger failed:", err));
          writeSyncLog({
            orgId: org.id,
            repoId: repo.id,
            message,
            level,
            timestamp,
          });
        };

        const indexStats = await indexRepository(
          repo.id,
          repo.fullName,
          repo.defaultBranch,
          installationId ?? 0,
          emitIndexLog,
          undefined,
          repo.provider,
          repo.organizationId,
        );

        await prisma.repository.update({
          where: { id: repo.id },
          data: {
            indexStatus: "indexed",
            analysisStatus: "none",
            indexedAt: new Date(),
            indexedFiles: indexStats.indexedFiles,
            totalFiles: indexStats.totalFiles,
            totalChunks: indexStats.totalChunks,
            totalVectors: indexStats.totalVectors,
            indexDurationMs: indexStats.durationMs,
            contributorCount: indexStats.contributorCount,
            contributors: JSON.parse(JSON.stringify(indexStats.contributors)),
            ...(indexStats.resolvedDefaultBranch ? { defaultBranch: indexStats.resolvedDefaultBranch } : {}),
          },
        });

        emitIndexLog(`Indexing complete: ${indexStats.indexedFiles} files, ${indexStats.totalVectors} vectors`, "success");

        pubby.trigger(indexChannel, "index-status", {
          repoId: repo.id,
          status: "indexed",
        }).catch((err) => console.error("[reviewer] Pubby index-status trigger failed:", err));

        console.log(`[reviewer] Indexing complete: ${indexStats.indexedFiles} files, ${indexStats.totalVectors} vectors`);

        await pubby.trigger(`presence-org-${org.id}`, "repo-indexed", {
          repoId: repo.id,
          fullName: repo.fullName,
          indexedFiles: indexStats.indexedFiles,
          totalVectors: indexStats.totalVectors,
        }).catch((err) => console.error("[reviewer] Pubby repo-indexed trigger failed:", err));

        eventBus.emit({
          type: "repo-indexed",
          orgId: org.id,
          repoFullName: repo.fullName,
          success: true,
          indexedFiles: indexStats.indexedFiles,
          totalVectors: indexStats.totalVectors,
          durationMs: indexStats.durationMs,
        });

        console.log(`[reviewer] Phase 0 complete -- ${repo.fullName} indexed`);
      }
    }

    // Spend limit check. Distinguish "out of credits" from "monthly cap": a
    // brand-new org that never got credit must not be told it "exceeded a
    // monthly limit", and the two reasons must be separable in the reviews
    // table (both used to write the same errorMessage — see credit-health).
    const spendStatus = await getOrgSpendLimitStatus(org.id, repo.id);
    if (spendStatus.blocked) {
      const outOfCredits = spendStatus.reason === "no_credits";
      console.warn(`[reviewer] Org ${org.id} blocked (${spendStatus.reason}) — skipping review`);
      // Link the CTA straight to checkout: blocked users see this comment a lot
      // (top live failure reason) but never convert — the old copy said "in
      // Settings" with no clickable path. See credit-health diagnosis.
      const appUrl = process.env.BETTER_AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "https://octopus-review.ai";
      const limitMsg = outOfCredits
        ? `> 🐙 **Octopus Review** — Your organization is **out of credits**. [**Add credits**](${appUrl}/settings/billing) or add your own [API keys](${appUrl}/settings/api-keys) to start receiving reviews again.`
        : `> 🐙 **Octopus Review** — Your organization has reached its monthly AI usage limit.\n>\n> [Raise your limit](${appUrl}/settings/billing) or add your own [API keys](${appUrl}/settings/api-keys) to continue receiving reviews.`;
      if (reviewCommentId) {
        await providerUpdateComment(reviewCommentId, limitMsg);
      } else {
        await publishMainComment(limitMsg);
      }
      await writeUnderClaim(claim, {
        status: "failed",
        errorMessage: outOfCredits ? "Out of credits" : "Monthly spend limit reached",
      });
      // Finalize the GitLab status as success — a billing limit is not a code
      // problem, so it must not block the MR merge (and leaving "running" would
      // strand it). GitHub uses no check here for the same reason.
      if (pr.headSha && usesProjectApi) {
        const statusMessage = outOfCredits
          ? "Review skipped — out of credits."
          : "Review skipped — monthly usage limit reached.";
        await projectProvider
          .setCommitStatus(org.id, projectPath, pr.headSha, "success", COMMIT_STATUS_NAME, statusMessage)
          .catch((e) => console.error("[reviewer] Failed to set provider status:", e));
      }
      return;
    }

    // Low-balance concurrency guard (#506): post-paid metering means N reviews
    // admitted at once can each pass the balance check and collectively
    // overspend. When a nearly-empty platform-billed org already has a review
    // in flight, re-queue this one to run after that finishes (and the balance
    // is re-checked), serializing spend down to one review at a time. Bounded:
    // the in-flight review completes → this retries and either runs or hits the
    // spend-limit block above once credits hit zero; stale reviews are reclaimed
    // by the existing stuck-review sweeper.
    if (await shouldGuardConcurrency(org.id)) {
      // Admission must be ATOMIC — a plain count-then-mark is check-then-act:
      // N parallel workers each see 0 in-flight (none marked yet) and all admit.
      // A transaction-scoped advisory lock keyed on the org serializes the
      // count+mark so exactly one review per org is admitted at a time. The
      // lock is held only for this fast count/update, not the whole review.
      const admitted = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${org.id}))`;
        const inFlight = await tx.pullRequest.count({
          where: {
            repository: { organizationId: org.id },
            status: "reviewing",
            id: { not: pr.id },
          },
        });
        if (inFlight > 0) return false;
        const admitted = await tx.pullRequest.updateMany({ where: claimWhere(claim), data: { status: "reviewing" } });
        return admitted.count > 0;
      });
      if (!admitted) {
        console.log(
          `[reviewer] Low balance + in-flight review for org ${org.id} — deferring PR ${pr.id}`,
        );
        // Same deferral as repository preparation: parked at `pending` so the
        // retry's claim can take it, run kept alive by the "deferred" outcome.
        if (await deferReviewForRepository(pullRequestId, pr.headSha, pr.reviewRequestVersion, reviewRunId, claim)) return "deferred";
        return finalizeSupersededDefer();
      }
    }

    const preparation = await ensureRepositoryAnalysis(repo.id, org.id, async () => {
      if (reviewCommentId) {
        await providerUpdateComment(
          reviewCommentId,
          "> 🐙 **Octopus Review** — Repository indexed ✓.\n>\n> Analyzing repository before reviewing this pull request... (Step 2/3)",
        );
      }
    });
    if (preparation === "waiting") {
      if (reviewCommentId) {
        await providerUpdateComment(
          reviewCommentId,
          "> 🐙 **Octopus Review** — Repository indexing or analysis is in progress.\n>\n> This review will retry automatically once repository preparation completes.",
        );
      }
      if (await deferReviewForRepository(pullRequestId, pr.headSha, pr.reviewRequestVersion, reviewRunId, claim)) return "deferred";
      return finalizeSupersededDefer();
    }
    if (isForgejoConnector) {
      if (pr.headSha) await forgejo.setCommitStatus(org.id, projectPath, pr.headSha, "running", COMMIT_STATUS_NAME, "Octopus review in progress");
      reviewCommentId = await publishMainComment("> 🐙 **Octopus Review** — Preparing review...");
    }
    if (reviewCommentId) {
      await providerUpdateComment(
        reviewCommentId,
        preparation === "empty"
          ? "> 🐙 **Octopus Review** — The base branch has no indexable content yet.\n>\n> Reviewing the changes in this pull request..."
          : "> 🐙 **Octopus Review** — Repository indexed and analyzed ✓.\n>\n> Starting PR review... (Step 3/3)",
      );
    }

    // Step 1: Mark as reviewing (idempotent — the guard may have set it already)
    await writeUnderClaim(claim, { status: "reviewing" });
    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "started",
    });

    // Step 2: Fetch diff from GitHub
    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "fetching-diff",
    });

    // Fetch the diff first, fall back to internal-cli if oversized, then
    // fetch the tree. Sequencing avoids orphaning a tree request when the
    // diff fetch throws (which we want to handle separately for large PRs).
    let rawDiff: string;
    let reviewInput: ReviewInput;
    try {
      const fetched = await providerGetInput(pr.number);
      rawDiff = fetched.rawDiff;
      reviewInput = fetched.input;
    } catch (err) {
      // PRs that exceed GitHub's diff size limits get handed off to internal-cli,
      // which clones the repo and computes the diff with `git diff base..head`.
      // Only GitHub raises LargePrError; Bitbucket has no equivalent yet.
      if (err instanceof LargePrError && isGitHub && installationId) {
        console.warn(
          `[reviewer] Routing PR #${pr.number} to internal-cli (${err.meta.reason})`,
        );
        await emitReviewStatus(org.id, {
          ...baseEvent,
          status: "reviewing",
          step: "delegating-large-pr",
        });
        // Enqueue BEFORE flipping the PR status so a crash between the two
        // can't strand the PR in "queued" with no job to process it. If the
        // enqueue throws we fall through to the outer catch which marks the
        // PR failed; if the post-update fails we still have a job that will
        // drive the PR to "completed"/"failed" via post-large-review-result.
        await enqueue("process-large-review", {
          pullRequestId: pr.id,
          // Carried so internal-cli can echo it back with the result. It is not in
          // this repository, so this is a request rather than a guarantee -- the
          // result handler falls back to resolving the run from the pull
          // request when it comes back without one.
          reviewRunId,
          orgId: org.id,
          repositoryId: repo.id,
          repoFullName: repo.fullName,
          installationId,
          prNumber: pr.number,
          prTitle: pr.title,
          prAuthor: pr.author,
          // The evidence-record id this execution generated for itself, distinct
          // from `reviewRunId` above.
          attemptId,
          reviewRequestVersion: pr.reviewRequestVersion,
          headSha: err.meta.headSha ?? null,
          baseSha: err.meta.baseSha ?? null,
          reviewCommentId: reviewCommentId ?? null,
          checkRunId: checkRunId ?? null,
          reason: err.meta.reason,
        });
        await writeUnderClaim(claim, { status: "queued", updatedAt: new Date() });
        // Marks this run, not just the pull request, as a genuine large-review
        // handoff: `review-request-admission.ts` reads it back to tell this
        // 30+ minute internal-cli wait apart from a pull request that merely
        // has status "queued" for a few seconds (a low-balance or
        // repository-preparation deferral), which must stay on the short
        // stuck-review window instead.
        if (reviewRunId) {
          await prisma.reviewRun.updateMany({
            where: { id: reviewRunId, terminalAt: null },
            data: { state: "queued" },
          });
        }
        return;
      }
      throw err;
    }
    const inputBaseRef = reviewInput.baseSha ?? repo.defaultBranch;
    const repoTree = await getRepoTreeCached(inputBaseRef);

    // Detect committed build artifacts / dependency folders
    const badFiles = detectBadCommits(rawDiff);
    if (badFiles.length > 0) {
      console.log(`[reviewer] Detected ${badFiles.length} build artifact / dependency files in diff`);
    }

    let gitattributes: string | null = null;
    let octopusIg: ReturnType<typeof parseOctopusIgnore> | undefined;
    const fetchBaseConfig = async (file: string): Promise<string | null> =>
      isGitHub && installationId
        ? ghGetFileContent(installationId, owner, repoName, inputBaseRef, file)
        : usesProjectApi
          ? projectProvider.getFileContent(org.id, projectPath, inputBaseRef, file)
          : bitbucket.getFileContent(org.id, owner, repoName, inputBaseRef, file);
    // A missing policy fetch must not cause files to disappear. Review them.
    if (repoTree.includes(".gitattributes")) {
      gitattributes = await fetchBaseConfig(".gitattributes").catch(() => null);
    }
    if (repoTree.includes(".octopusignore")) {
      const content = await fetchBaseConfig(".octopusignore").catch(() => null);
      if (content) octopusIg = parseOctopusIgnore(content);
    }
    const preparationOptions = {
      maxChars: MAX_DIFF_CHARS,
      generated: buildGeneratedMatcher(gitattributes),
      ignored: octopusIg,
    };
    const baselineInput = prepareReviewInput(reviewInput, preparationOptions);
    // Freeze ordinary routing against the baseline. A larger candidate never selects another model.
    // `modelOverride` comes from the run's own config snapshot, so a review asked
    // for with a label is billed to the model that label named. rayf P-0007 C3.
    const reviewModel = await resolveReviewModel({
      orgId: org.id,
      repoId: repo.id,
      modelOverride: reviewConfig.modelOverride,
      diff: baselineInput.diff,
      coverage: baselineInput.coverage,
    });
    const resolvedProvider = reviewModel === "claude-fable-5-1" && executionWindow
      ? await getProviderForModel(reviewModel) : null;
    const candidate = resolvedProvider ? completeReviewCandidate(reviewInput, preparationOptions, baselineInput,
      reviewModel, resolvedProvider, executionWindow) : null;
    const preparedInput = candidate ?? baselineInput;
    const candidateSha256 = candidate ? reviewCandidateSha256(candidate) : null;
    const { diff, coverage, inventoryDiff } = preparedInput;
    attemptCoverage = coverage;
    coverage.reviewRequestVersion = pr.reviewRequestVersion;
    if (checkRunId !== null) coverage.nativeCheckId = String(checkRunId);
    const commentContext = prepareReviewComment(pr.triggerCommentBody ?? "");
    coverage.comment = commentContext.receipt;
    const diffFiles = extractDiffFiles(diff);
    const filesChanged = reviewInput.expectedFiles ?? reviewInput.files.length;

    console.log(`[reviewer] Using model: ${reviewModel}`);

    // Merge PR diff files into the repo tree so new files added by the PR
    // are visible in the file tree — prevents false positives about "missing" modules.
    const treeSet = new Set(repoTree);
    for (const f of reviewInput.files) treeSet.add(f.path);
    const mergedTree = treeSet.size > repoTree.length ? Array.from(treeSet) : repoTree;

    console.log(`[reviewer] Diff fetched: ${diff.length} chars, ${filesChanged} files, tree: ${mergedTree.length} files (${mergedTree.length - repoTree.length} added from diff)`);

    // No supplied hunks means there is no safe material for a model review.
    // Preserve missing/ignored inventory rather than interpreting an empty
    // selected diff as an empty PR or spending tokens on unrelated RAG context.
    if (!diff.trim()) {
      recordNoModelAssessment(coverage);
      const body = applyReviewCoverage("No changed text hunks were supplied for review.", coverage, attemptId);
      await saveReviewAttempt(attemptId, pr.id, coverage, body, [], claim);
      attemptSaved = true;
      if (isGitHub) reviewCommentId = await publishMainComment(body, body);
      else if (reviewCommentId) await providerUpdateComment(reviewCommentId, body);
      else await publishMainComment(body);
      const result = reviewCheckResult(coverage, false, 0);
      if (checkRunId && isGitHub && installationId) {
        await ghUpdateCheckRun(installationId, owner, repoName, checkRunId, result.conclusion, { title: result.title, summary: result.summary });
      }
      if (pr.headSha && usesProjectApi) {
        await projectProvider.setCommitStatus(org.id, projectPath, pr.headSha, result.conclusion === "success" ? "success" : "failed", COMMIT_STATUS_NAME, result.summary);
      }
      await recordFirstReviewCompletion(pr.id, pr.headSha, pr.reviewRequestVersion, body, claim);
      await emitReviewStatus(org.id, { ...baseEvent, status: "completed", step: "completed", detail: result.summary });
      return;
    }

    // Step 3: Embed diff → semantic search for codebase context
    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "searching-context",
    });

    // Retrieval query composed from title + changed paths + hunk headers +
    // identifiers (not raw +/- churn), so every changed file is represented
    // regardless of diff size (#651). Bounded (<=4000 chars) — no cost increase
    // vs the old 8000-char slice.
    const searchText = buildRetrievalQuery(inventoryDiff + diff, pr.title);
    console.log(`[reviewer] Retrieval query: ${searchText.length} chars from ${diffFiles.size} changed files`);
    const [queryVector] = await createEmbeddings([searchText], {
      organizationId: org.id,
      operation: "embedding",
      repositoryId: repo.id,
    });

    // Over-fetch from Qdrant, then rerank with Cohere (same composed query).
    const rerankQuery = searchText;

    // Deterministic tool pre-pass (#643): opt-in per repo, no-op without the
    // semgrep binary. Fetches the changed files' new content and runs a curated
    // OFFLINE semgrep ruleset, returning a ground-truth findings block for the
    // prompt. Best-effort — any failure yields "" and the LLM review proceeds.
    const runToolPrePass = async (): Promise<string> => {
      if (!toolPrePassEnabled(reviewConfig)) return "";
      try {
        const ref = pr.headSha ?? repo.defaultBranch ?? "main";
        const fetchContent = (p: string): Promise<string> =>
          isGitHub
            ? ghGetFileContent(installationId!, owner, repoName, ref, p).then((c) => c ?? "")
            : usesProjectApi
              ? projectProvider.getFileContent(org.id, projectPath, ref, p)
              : bitbucket.getFileContent(org.id, owner, repoName, ref, p);
        const paths = [...diffFiles].slice(0, 200);
        // Bounded concurrency so a large PR can't fire hundreds of parallel
        // content fetches at the provider API.
        const files: { path: string; content: string }[] = [];
        const FETCH_CONCURRENCY = 8;
        for (let i = 0; i < paths.length; i += FETCH_CONCURRENCY) {
          const batch = await Promise.all(
            paths.slice(i, i + FETCH_CONCURRENCY).map(async (p) => ({ path: p, content: await fetchContent(p).catch(() => "") })),
          );
          for (const f of batch) if (f.content) files.push(f);
        }
        const rulesPath = path.join(process.cwd(), "prompts", "semgrep-rules.yaml");
        const raw = await runSemgrepPrePass(files, rulesPath);
        // Scope to lines actually visible in the diff — semgrep scans whole
        // files, so a finding on unchanged code the PR never touched is dropped.
        const findings = filterToChangedLines(raw, parseDiffLines(diff));
        if (findings.length) console.log(`[reviewer] Tool pre-pass: ${findings.length}/${raw.length} semgrep finding(s) on changed lines`);
        return formatToolFindings(findings);
      } catch (err) {
        console.warn("[reviewer] Tool pre-pass failed, continuing:", err);
        return "";
      }
    };

    const [rawCodeChunks, rawKnowledgeChunks, alwaysIncludeKnowledge, rawPastReviews, prBody, toolFindingsBlock] = await Promise.all([
      searchSimilarChunks(repo.id, queryVector, 50, rerankQuery),
      searchKnowledgeChunks(org.id, queryVector, 25, rerankQuery).catch(() => [] as { title: string; text: string; score: number }[]),
      getAlwaysIncludeKnowledge(org.id).catch(() => []),
      // Past reviews on similar code — reuses the query vector (no extra
      // embedding/LLM cost) and runs in parallel with the other retrievals.
      searchReviewChunks(org.id, queryVector, 6, rerankQuery).catch(() => []),
      // PR description — gives the reviewer the change's intent. Runs in
      // parallel; best-effort (empty on failure).
      providerGetPrBody(pr.number),
      // Deterministic tool pre-pass (#643) — opt-in per repo, default off, and a
      // no-op unless the semgrep binary is present. Runs in parallel with
      // retrieval so it adds no latency on the critical path.
      runToolPrePass(),
    ]);

    const [contextChunks, similarityKnowledgeChunks] = await Promise.all([
      rerankDocuments(rerankQuery, rawCodeChunks, {
        topK: 15,
        scoreThreshold: 0.25,
        minResults: 3,
        organizationId: org.id,
        operation: "review-rerank",
      }),
      rerankDocuments(rerankQuery, rawKnowledgeChunks, {
        topK: 8,
        scoreThreshold: 0.20,
        minResults: 1,
        organizationId: org.id,
        operation: "review-rerank",
      }),
    ]);

    const knowledgeChunks = mergeKnowledgeChunks(alwaysIncludeKnowledge, similarityKnowledgeChunks);

    const codebaseContext = contextChunks
      .map(
        (c) =>
          `// ${c.filePath}:L${c.startLine}-L${c.endLine}\n${c.text}`,
      )
      .join("\n\n---\n\n");

    const knowledgeContext = knowledgeChunks.length > 0
      ? knowledgeChunks.map((c) => c.text).join("\n\n---\n\n")
      : "";

    // Format past reviews retrieved above (in the parallel batch) into the
    // prompt block; excludes this PR's own prior review, caps and score-floors.
    const pastReviewsContext = formatPastReviews(rawPastReviews, pr.number, repo.fullName);

    // The change's intent (title + description + linked issues) so the reviewer
    // can flag "does not accomplish stated goal" / missing-requirement / scope
    // creep. Author-controlled → treated as untrusted in the prompt.
    const prIntent = formatPrIntent(pr.title, prBody);

    // Curated anti-pattern rulepacks for the languages in this diff + the
    // always-on security pack (#649). Deterministic dispatch, no retrieval cost.
    const patternRules = selectRulePacks(diff);

    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "searching-context",
      detail: `${contextChunks.length}/${rawCodeChunks.length} code chunks after rerank, ${knowledgeChunks.length} knowledge chunks (${alwaysIncludeKnowledge.length} pinned + ${similarityKnowledgeChunks.length}/${rawKnowledgeChunks.length} from search)`,
    });

    console.log(
      `[reviewer] Context: ${contextChunks.length}/${rawCodeChunks.length} code chunks, ${knowledgeChunks.length} knowledge chunks (${alwaysIncludeKnowledge.length} pinned + ${similarityKnowledgeChunks.length}/${rawKnowledgeChunks.length} from search)`,
    );

    // Step 4: Build prompt and call Anthropic
    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "generating-review",
    });

    // Fetch past feedback (disliked = false positive, liked = valuable) for this repo
    // Aggregate into compact patterns instead of dumping raw findings
    let falsePositiveContext = "";
    try {
      const feedbackIssues = await prisma.reviewIssue.findMany({
        where: {
          feedback: { not: null },
          pullRequest: { repositoryId: repo.id },
        },
        select: {
          title: true,
          severity: true,
          feedback: true,
        },
        orderBy: { feedbackAt: "desc" },
        take: 200,
      });

      if (feedbackIssues.length > 0) {
        // Group by feedback type + normalized title to deduplicate
        const normalize = (t: string) => t.replace(/`[^`]+`/g, "...").replace(/\s+/g, " ").trim().toLowerCase();
        const groups = new Map<string, { title: string; severity: string; count: number; feedback: string }>();

        for (const issue of feedbackIssues) {
          const key = `${issue.feedback}:${normalize(issue.title)}`;
          const existing = groups.get(key);
          if (existing) {
            existing.count++;
          } else {
            groups.set(key, { title: issue.title, severity: issue.severity, count: 1, feedback: issue.feedback! });
          }
        }

        // Sort by count (most frequent feedback first), take top patterns
        const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
        const disliked = sorted.filter((g) => g.feedback === "down").slice(0, 10);
        const liked = sorted.filter((g) => g.feedback === "up").slice(0, 5);

        const parts: string[] = [];
        if (disliked.length > 0) {
          parts.push(
            "FALSE POSITIVES (the team marked these as unhelpful — do NOT repeat similar findings):",
            ...disliked.map((g) => `- "${g.title}" (${g.count}x, ${g.severity})`),
          );
        }
        if (liked.length > 0) {
          parts.push(
            "",
            "VALUED FINDINGS (the team found these helpful — prioritize similar patterns):",
            ...liked.map((g) => `- "${g.title}" (${g.count}x, ${g.severity})`),
          );
        }

        if (parts.length > 0) {
          falsePositiveContext = parts.join("\n");
          console.log(`[reviewer] Feedback context: ${disliked.length} false positive patterns, ${liked.length} valued patterns (from ${feedbackIssues.length} total feedback)`);
        }
      }
    } catch (err) {
      console.warn("[reviewer] Failed to fetch feedback context:", err);
    }

    // Fetch prior review comments once — shared by prompt context injection and inline dedup.
    const appSlug = (await getGithubAppConfig())?.slug ?? "octopus-review";
    const botLogin = `${appSlug}[bot]`;
    let allPriorReviewComments: import("@/lib/github").PRReviewComment[] = [];
    const priorSummaryTableFindings: PriorFinding[] = [];
    if (isGitHub && installationId) {
      try {
        allPriorReviewComments = await ghListPullRequestReviewComments(installationId, owner, repoName, pr.number);
      } catch (err) {
        console.warn("[reviewer] Failed to fetch prior review comments:", err);
      }

      // Fetch prior review bodies to extract findings from summary tables.
      // This catches findings that were posted in the collapsed "Additional findings"
      // table rather than as inline comments (e.g., when inline threshold is high).
      try {
        const priorReviews = await ghListPullRequestReviews(installationId, owner, repoName, pr.number);
        const botReviews = priorReviews.filter((r) => r.user === botLogin && r.body);
        for (const review of botReviews) {
          const tableFindings = parseFindingsFromSummaryTable(review.body);
          priorSummaryTableFindings.push(...tableFindings);
        }
        if (priorSummaryTableFindings.length > 0) {
          console.log(`[reviewer] Found ${priorSummaryTableFindings.length} prior findings from ${botReviews.length} review summary tables`);
        }
      } catch (err) {
        console.warn("[reviewer] Failed to fetch prior review bodies:", err);
      }
    }

    // Provider comments survive failed/partial attempts. Restrict follow-up
    // findings only when the preceding request completed the eligible scope.
    let priorReviewContext = "";
    let dismissedDbFindings: { title: string; description: string | null; severity: string; filePath: string | null; lineNumber: number | null }[] = [];
    const botComments = allPriorReviewComments.filter((c) => !c.inReplyToId && c.user === botLogin && c.line != null);
    const isReReview = await canRestrictReviewToFollowUp(pr.id, coverage);

    if (isReReview) {
      const parts: string[] = [
        "⚠️ RE-REVIEW MODE — STRICT DEDUPLICATION REQUIRED ⚠️",
        "",
        "This PR has already been reviewed. Your ONLY job is to verify whether previously raised findings have been addressed. Follow these rules with ZERO exceptions:",
        "",
        "RULE 1 — NO NEW FINDINGS: Do NOT raise any new findings UNLESS they are 🔴 CRITICAL severity AND were clearly introduced by code changes made AFTER the last review. If the code existed in the prior review, you already had your chance to flag it.",
        "",
        "RULE 2 — NO REPEATS: Do NOT rephrase, reframe, re-angle, or re-raise ANY previously raised finding. This applies even if you use completely different wording. Examples of PROHIBITED repeats:",
        '  - Prior: "Inefficient blob buffering" → New: "Memory inefficient blob buffering" (SAME finding, different adjective)',
        '  - Prior: "Console.error in production" → New: "Console.log in production" (SAME concept)',
        '  - Prior: "Missing auth check" → New: "No authentication verification" (SAME issue rephrased)',
        "  A finding is a repeat if it targets the same file, nearby lines (±10), and the same conceptual issue.",
        "",
        "RULE 3 — AUTHOR RESPONSES MEAN DISMISSED: When the author has replied to a finding with an explanation, that finding is DISMISSED. Do not re-raise it, even if you disagree with the author's reasoning. The author knows their codebase better than you.",
        "",
        "RULE 4 — EMPTY IS GOOD: If all previous findings are addressed and no critical new issues exist, the findings list MUST be empty. An empty findings list on re-review is the EXPECTED outcome.",
        "",
        "RULE 5 — SELF-CHECK: Before including ANY finding in your output, ask yourself: 'Does this finding overlap with ANY item in PRIOR INLINE COMMENTS or DISMISSED FINDINGS below?' If yes, EXCLUDE it.",
        "",
        "RULE 6 — SCORE MUST REFLECT CURRENT STATE: Score each category based on the PR as it stands NOW (all commits combined). Items marked ✅ RESOLVED below have been fixed by the author (the code at that location has changed since your last review). If a prior finding is resolved — especially if the author applied YOUR OWN suggestion — that category's score MUST improve. A fixed security issue means Security should be 4/5 or 5/5, NOT the old score. Do NOT penalize for resolved issues.",
      ];

      // Build a map of bot comment ID → author reply bodies for inline dismissals
      const repliesByBotComment = new Map<number, string[]>();
      for (const c of allPriorReviewComments) {
        if (c.inReplyToId && c.user !== botLogin) {
          const replies = repliesByBotComment.get(c.inReplyToId) ?? [];
          replies.push(c.body);
          repliesByBotComment.set(c.inReplyToId, replies);
        }
      }

      if (botComments.length > 0) {
        const summaries = botComments.map((c) => {
          // Include first two lines for better context (title + description start)
          const bodyLines = c.body.split("\n").filter((l) => l.trim());
          const summary = bodyLines.slice(0, 2).map((l) => l.replace(/\*\*/g, "").trim()).join(" — ");
          const resolvedTag = c.isOutdated ? " ✅ RESOLVED (code changed)" : "";
          let entry = `- ${c.path}:${c.line} — ${summary}${resolvedTag}`;

          // Include author replies (especially dismissals) so the LLM understands why it was rejected
          const replies = repliesByBotComment.get(c.id);
          if (replies && replies.length > 0) {
            const replyTexts = replies.map((r) => r.trim().slice(0, 200)).join("; ");
            entry += `\n  Author response: ${replyTexts}`;
          }

          return entry;
        });
        parts.push(
          "",
          "═══ PRIOR INLINE COMMENTS (BLOCKED — every item below is BANNED from your output, even with different wording) ═══",
          ...summaries,
        );
      }

      // Include findings from prior review summary tables (catches findings that
      // were never posted as inline comments — e.g. when inline threshold is high)
      if (priorSummaryTableFindings.length > 0) {
        // Deduplicate against inline comments already listed above
        const inlineKeys = new Set(botComments.map((c) => `${c.path}:${c.line}`));
        const uniqueTableFindings = priorSummaryTableFindings.filter(
          (f) => !inlineKeys.has(`${f.filePath}:${f.line}`),
        );
        if (uniqueTableFindings.length > 0) {
          parts.push(
            "",
            "═══ PRIOR SUMMARY TABLE FINDINGS (BLOCKED — these were raised in previous reviews, do NOT repeat) ═══",
            ...uniqueTableFindings.map((f) => `- ${f.filePath}:${f.line} — "${f.title}"`),
          );
        }
      }

      // Fetch this PR's dismissed findings from the database for explicit dedup
      try {
        const dismissedFindings = await prisma.reviewIssue.findMany({
          where: {
            pullRequestId: pr.id,
            feedback: "down",
          },
          select: {
            title: true,
            description: true,
            severity: true,
            filePath: true,
            lineNumber: true,
            feedbackBy: true,
          },
          orderBy: { feedbackAt: "desc" },
          take: 30,
        });

        // Store for hard dedup filter later
        dismissedDbFindings = dismissedFindings;

        if (dismissedFindings.length > 0) {
          parts.push(
            "",
            "═══ DISMISSED FINDINGS (BANNED — the author explicitly rejected these, do NOT repeat or rephrase) ═══",
            ...dismissedFindings.map((f) => {
              const desc = f.description ? ` — ${f.description.slice(0, 150)}` : "";
              return `- [${f.severity}] ${f.filePath ?? "unknown"}: "${f.title}"${desc}`;
            }),
          );
        }
      } catch (err) {
        console.warn("[reviewer] Failed to fetch dismissed findings for re-review context:", err);
      }

      priorReviewContext = parts.join("\n");
      console.log(`[reviewer] Re-review detected: ${botComments.length} prior inline comments, injecting re-review instructions`);
    }

    const FILE_TREE_IGNORE = [
      // JS/TS ecosystem
      "node_modules/", "dist/", "build/", ".next/", ".nuxt/",
      ".svelte-kit/", ".output/", ".turbo/", ".cache/",
      // C# / .NET
      "bin/", "obj/", "packages/", ".vs/",
      // Java / Kotlin
      "target/", ".gradle/", ".mvn/",
      // Python
      "__pycache__/", ".venv/", "venv/", ".tox/", ".mypy_cache/",
      // Go / Rust
      "vendor/",
      // IDE / editor configs
      ".vscode/", ".idea/", ".eclipse/", ".settings/",
      // Git / CI artifacts
      ".git/", "coverage/",
      // Lock files
      "package-lock.json", "bun.lock", "yarn.lock", "pnpm-lock.yaml",
    ];
    const MAX_TREE_FILES = 2000;

    const filteredTree = mergedTree
      .filter((p) => !FILE_TREE_IGNORE.some((ig) => p.includes(ig)))
      .filter((p) => !octopusIg?.ignores(p));
    const fileTree = filteredTree.length > MAX_TREE_FILES
      ? filteredTree.slice(0, MAX_TREE_FILES).join("\n") + `\n... and ${filteredTree.length - MAX_TREE_FILES} more files`
      : filteredTree.join("\n");

    const enableConflict = reviewConfig.enableConflictDetection !== undefined
      ? reviewConfig.enableConflictDetection
      : touchesSharedFiles(diff);
    const conflictPrompt = enableConflict ? getConflictDetectionPrompt() : "";
    const reviewLanguage = resolveReviewLanguage(org.reviewLanguage);

    // Repo-level config: opt-in per repo. Fetch from repo at PR head, then run a
    // sandboxed Haiku pass to extract a clean rule list. Cached by content hash.
    let repoConfigUserBlock = "";
    if (repo.useRepoConfig) {
      try {
        const candidates = normalizeRepoConfigFiles(repo.repoConfigFiles);
        const ref = pr.headSha ?? repo.defaultBranch ?? "main";
        const source = await fetchRepoConfigFile({
          provider: repo.provider,
          installationId: installationId ?? null,
          organizationId: org.id,
          owner,
          repo: repoName,
          branch: ref,
          candidates,
        });
        if (source) {
          const extracted = await extractRepoConfigRules(repo.id, org.id, source);
          repoConfigUserBlock = buildRepoConfigUserBlock(extracted);
          console.log(
            `[reviewer] Repo config: ${source.source} (${source.rawContent.length}B${source.truncated ? ", truncated" : ""}); extracted=${extracted ? (extracted.cached ? "cached" : "fresh") : "none"}`,
          );
        } else {
          console.log(`[reviewer] Repo config: no candidate file found in ${candidates.join(", ")}`);
        }
      } catch (err) {
        console.warn(`[reviewer] Repo config processing failed:`, err);
      }
    }

    // Function-form replace via substitutePromptVars so `$&` / `$'` / `$\`` /
    // `$<name>` in replacement values (codebase context, user instruction,
    // knowledge context, PR titles, translated review-language names) are
    // taken literally instead of as `String.replace` substitution patterns.
    // See `prompt-substitute.ts` for the rationale.
    const systemPrompt = substitutePromptVars(getSystemPrompt(), {
      CODEBASE_CONTEXT: codebaseContext,
      FILE_TREE: fileTree,
      KNOWLEDGE_CONTEXT: knowledgeContext,
      PAST_REVIEWS_CONTEXT: pastReviewsContext,
      PR_INTENT: prIntent,
      PATTERN_RULES: patternRules,
      TOOL_FINDINGS: toolFindingsBlock,
      PR_NUMBER: String(pr.number),
      PROVIDER: isGitHub ? "GitHub" : isBitbucket ? "Bitbucket" : isGitlab ? "GitLab" : isForgejo ? "Forgejo" : repo.provider,
      FALSE_POSITIVE_CONTEXT: falsePositiveContext,
      RE_REVIEW_CONTEXT: priorReviewContext,
      CONFLICT_DETECTION: conflictPrompt,
      REVIEW_LANGUAGE: reviewLanguage.code,
      REVIEW_LANGUAGE_NAME: reviewLanguage.promptName,
    });

    const completeReviewAdmission: CompleteReviewAdmission | undefined = candidateSha256 && executionWindow ? {
      candidateSha256, headSha: coverage.headSha!, baseSha: coverage.baseSha!, reviewRequestVersion: pr.reviewRequestVersion,
      preparedSource: { chars: diff.length, files: coverage.files.filter(file => file.state === "supplied").length,
        hunks: coverage.files.reduce((total, file) => total + file.hunks.length, 0) },
      window: executionWindow,
      beforeGeneration: signal => confirmCompleteReviewCurrent({ pullRequestId: pr.id, orgId: org.id, repoId: repo.id,
        model: reviewModel, headSha: coverage.headSha!, baseSha: coverage.baseSha!, reviewRequestVersion: pr.reviewRequestVersion,
        fetchRevision: signal => isGitHub ? ghGetPullRequestDetails(installationId!, owner, repoName, pr.number, signal)
          : usesProjectApi ? projectProvider.getPullRequestDetails(org.id, projectPath, pr.number, signal)
            : bitbucket.getPullRequestDetails(org.id, owner, repoName, pr.number, signal),
      }, signal),
    } : undefined;
    const primaryRequest = createCoveredReviewRequest({
      model: reviewModel, system: systemPrompt, number: pr.number, title: pr.title,
      author: pr.author, diff, coverage, comment: pr.triggerCommentBody ?? "",
      repoConfig: repoConfigUserBlock,
    });
    adaptiveProcessingWindow = completeReviewAdmission?.window;
    const response = await executeCoveredReview({ ...primaryRequest, ...(completeReviewAdmission ? { completeReviewAdmission } : {}) },
      coverage, getSystemPrompt(), request => createAiMessage(request, org.id));
    const assertProcessingActive = () => { if (completeReviewAdmission) assertReviewProcessingActive(completeReviewAdmission.window); };

    let reviewBody = prepareReviewPresentation(response.text, coverage);

    // Prepend build artifact warning if bad files were detected in the diff
    if (badFiles.length > 0) {
      const badFilesSection = [
        "#### 🔴 Critical: Build artifacts / dependency folders committed",
        "",
        "The following files should NOT be committed to the repository. Add them to `.gitignore` and remove them from version control:",
        "",
        ...badFiles.slice(0, 20).map((f) => `- \`${f}\``),
        badFiles.length > 20 ? `- ... and ${badFiles.length - 20} more` : "",
        "",
      ].filter(Boolean).join("\n");
      reviewBody = badFilesSection + "\n\n" + reviewBody;
    }

    // Deterministic output scope is independent of what the model claims.
    reviewBody = applyReviewCoverage(reviewBody, coverage, attemptId);

    await logAiUsage({
      provider: response.provider,
      usedOwnKey: response.usedOwnKey,
      model: reviewModel,
      operation: "review",
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
      organizationId: org.id,
    });
    // A completed response is still metered before expiry stops further review processing.
    assertProcessingActive();

    const findingsCount = countFindings(reviewBody);
    console.log(`[reviewer] Review generated: ${reviewBody.length} chars, ${findingsCount} findings`);

    // Step 5: Post review to PR
    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "reviewing",
      step: "posting-comment",
    });

    // Prepare the main report; publish it after storing the final immutable outcome.
    let mainCommentBody = stripDetailedFindings(reviewBody);

    // Re-review with zero new findings: surface this as an explicit positive
    // signal instead of letting the developer wonder if the review failed.
    if (reviewAssessmentComplete(coverage) && isReReview && findingsCount === 0) {
      const commitSuffix = pr.headSha ? ` (commit \`${pr.headSha.slice(0, 7)}\`)` : "";
      mainCommentBody =
        `> ✅ No new issues detected since the last review${commitSuffix}.\n\n` +
        mainCommentBody;

      // Our own objections are answered, so close them. Approving over a thread we
      // opened and still call unresolved says two contradictory things at once, and a
      // reader cannot tell which one the reviewer meant.
      //
      // Only threads we opened, and only on a re-review that found nothing: a thread
      // somebody else opened is not ours to close, and a first review has nothing to
      // have been fixed.
      try {
        const slug = (await getGithubAppConfig())?.slug ?? "octopus-review";
        const mine = installationId
          ? await listOwnUnresolvedThreads(installationId, owner, repoName, pr.number, `${slug}[bot]`)
          : [];
        for (const thread of mine) {
          await resolveReviewThread(installationId as number, thread.id).catch((err) =>
            console.warn(`[reviewer] could not resolve thread ${thread.id}:`, err),
          );
        }
        if (mine.length > 0) {
          console.log(`[reviewer] resolved ${mine.length} of our threads on PR ${pr.number}`);
        }
      } catch (err) {
        // Tidying is not the review. A failure here must not lose the verdict.
        console.warn(`[reviewer] thread cleanup failed on PR ${pr.number}:`, err);
      }
    }

    // 5b: Parse findings and submit inline review comments
    let findings = parseFindings(reviewBody);
    let effectiveReviewBody = reviewBody;

    // Debug: log whether JSON or markdown markers were found
    const hasJsonMarkers = reviewBody.includes(FINDINGS_START_MARKER);
    const hasLegacyMarkers = /<details>\s*\n\s*<summary>\s*Detailed Findings/i.test(reviewBody);
    console.log(`[reviewer] Findings parse result: ${findings.length} findings (jsonMarkers=${hasJsonMarkers}, legacyMarkers=${hasLegacyMarkers})`);

    // Fallback: if Findings Summary table count exceeds parsed findings,
    // make a follow-up call to extract the missing findings
    const tableFindingsTotal = countFindingsFromTable(reviewBody);
    const hasMissingFindings = tableFindingsTotal > 0 && findings.length < tableFindingsTotal;
    if (hasMissingFindings) {
      const missingCount = tableFindingsTotal - findings.length;
      console.warn(`[reviewer] ⚠️ Findings table reports ${tableFindingsTotal} but only ${findings.length} parsed (${missingCount} missing) — requesting findings via follow-up call`);
      try {
          const followUp = await executeFindingsRecovery(
            { model: reviewModel, reviewBody, parsedFindingsCount: findings.length, tableFindingsTotal },
            coverage,
            request => createAiMessage({ ...request, ...(completeReviewAdmission ? { executionWindow } : {}) }, org.id),
          );

          const findingsBlock = followUp.text;

          await logAiUsage({
            provider: followUp.provider,
            usedOwnKey: followUp.usedOwnKey,
            model: reviewModel,
            operation: "review-findings-followup",
            inputTokens: followUp.usage.inputTokens,
            outputTokens: followUp.usage.outputTokens,
            cacheReadTokens: followUp.usage.cacheReadTokens,
            cacheWriteTokens: followUp.usage.cacheWriteTokens,
            organizationId: org.id,
          });

          const followUpFindings = followUp.findings;
          if (followUpFindings === null) {
            const rejected = prepareRecoveredReviewPresentation(reviewBody, findingsBlock, [], coverage);
            if (rejected !== null) {
              reviewBody = rejected;
              effectiveReviewBody = rejected;
              mainCommentBody = stripDetailedFindings(rejected);
              findings = parseFindings(rejected);
            }
          }
          if (followUpFindings && followUpFindings.length > 0) {
            // Merge: add only findings not already present (by file+title dedup)
            const existingKeys = new Set(findings.map((f) => `${f.filePath}:${f.title}`));
            const newFindings = followUpFindings.filter((f) => !existingKeys.has(`${f.filePath}:${f.title}`));
            findings = [...findings, ...newFindings];
            // Append findings block to reviewBody so it gets stored in DB
            effectiveReviewBody = `${reviewBody}\n\n${FINDINGS_START_MARKER}\n\`\`\`json\n${JSON.stringify(followUpFindings, null, 2)}\n\`\`\`\n${FINDINGS_END_MARKER}`;
            const containedRecovery = prepareRecoveredReviewPresentation(reviewBody, findingsBlock, findings, coverage);
            if (containedRecovery !== null) {
              reviewBody = containedRecovery;
              effectiveReviewBody = containedRecovery;
              mainCommentBody = stripDetailedFindings(containedRecovery);
              findings = parseFindings(containedRecovery);
            }
            console.log(`[reviewer] Follow-up recovered ${newFindings.length} new findings (${followUpFindings.length} total from follow-up, ${findings.length} combined) (provider: ${repo.provider}, pr: #${pr.number})`);
          } else {
            console.warn(`[reviewer] Follow-up also returned no parseable findings (provider: ${repo.provider}, pr: #${pr.number})`);
          }
        } catch (err) {
          console.error("[reviewer] Follow-up findings call failed:", err);
        }
    }

    enforceReviewFindingsIntegrity(response.text, effectiveReviewBody, coverage, true);

    // Save all parsed findings before filtering — these will be shown in the summary comment
    let allParsedFindings = [...findings];

    // Filter out findings below confidence threshold (per-category: high-risk
    // categories like Security/Bug get a relaxed threshold so genuine issues
    // are not silently dropped — see review-categories.ts).
    const confidenceThreshold = resolveConfidenceThreshold(reviewConfig);
    // #647: run confidence filter, category filter, suppression AND validation on
    // the FULL parsed union — not just the inline subset — so the summary table
    // and persisted DB rows carry post-validation confidence and never show a
    // finding the validator/threshold would drop. Inline vs summary is derived
    // from this single validated set further below.
    const beforeConfidence = allParsedFindings.length;
    allParsedFindings = filterByConfidence(allParsedFindings, confidenceThreshold);
    if (beforeConfidence !== allParsedFindings.length) {
      console.log(`[reviewer] Filtered out ${beforeConfidence - allParsedFindings.length} findings below per-category confidence threshold (base ${confidenceThreshold})`);
    }

    // Filter out disabled categories
    if (reviewConfig.disabledCategories && reviewConfig.disabledCategories.length > 0) {
      const disabled = new Set(reviewConfig.disabledCategories.map((c) => c.toLowerCase()));
      const before = allParsedFindings.length;
      allParsedFindings = allParsedFindings.filter((f) => !disabled.has(f.category.toLowerCase()));
      if (allParsedFindings.length !== before) {
        console.log(`[reviewer] Filtered out ${before - allParsedFindings.length} findings from disabled categories`);
      }
    }

    // Apply the shared policy to the full union before validation/presentation.
    assertProcessingActive();
    allParsedFindings = await suppressFindingsFromFeedback(allParsedFindings, { repoId: repo.id, orgId: org.id });
    assertProcessingActive();

    // Two-pass validation: re-score confidence on the FULL union with cross-file
    // context. Runs once on allParsedFindings so both the summary table and the
    // inline subset carry validated confidence (#647).
    if (allParsedFindings.length > 0) {
      try {
        const fileContentFetcher: FileContentFetcher | undefined =
          isGitHub && installationId && pr.headSha
            ? async (path) => (await ghGetFileContent(installationId!, owner, repoName, pr.headSha!, path)) ?? ""
            : isBitbucket
              ? (path) => bitbucket.getFileContent(org.id, owner, repoName, pr.headSha ?? repo.defaultBranch ?? "main", path)
              : usesProjectApi
                ? (path) => projectProvider.getFileContent(org.id, projectPath, pr.headSha ?? repo.defaultBranch ?? "main", path)
                : undefined;

        // Phase 1: Cross-file context (existing — function signatures, types, APIs)
        let crossFileContext = "";
        const crossFileQueries = extractCrossFileQueries(allParsedFindings, diff);
        if (crossFileQueries.length > 0) {
          assertProcessingActive();
          crossFileContext = await gatherCrossFileContext(crossFileQueries, repo.id, org.id, fileContentFetcher);
          assertProcessingActive();
          if (crossFileContext) {
            console.log(`[reviewer] Gathered cross-file context: ${crossFileQueries.length} queries, ${crossFileContext.length} chars`);
          }
        }

        // Phase 2: Verification context (new — verify each finding's claims via Qdrant)
        let verificationContext: Map<number, string> | undefined;
        const verificationQueries = generateVerificationQueries(allParsedFindings);
        if (verificationQueries.length > 0) {
          assertProcessingActive();
          verificationContext = await gatherVerificationContext(verificationQueries, repo.id, org.id, fileContentFetcher);
          assertProcessingActive();
          if (verificationContext.size > 0) {
            console.log(`[reviewer] Gathered verification context: ${verificationQueries.length} queries → ${verificationContext.size} findings verified`);
          }
        }

        assertProcessingActive();
        allParsedFindings = await validateFindings(allParsedFindings, diff, org.id, reviewModel, confidenceThreshold, crossFileContext || undefined, "[reviewer]", verificationContext, fileTree);
        assertProcessingActive();
      } catch (err) {
        if (err instanceof ReviewProcessingExpiredError) throw err;
        console.warn("[reviewer] Two-pass validation failed, keeping all findings:", err);
      }
    }

    // Inline vs summary are both derived from the validated union from here on.
    findings = [...allParsedFindings];

    // What the model found once validated, BEFORE anything below removes a
    // finding from view: prior-comment dedup hides a finding because it was
    // already raised, and the re-review filter hides everything non-critical.
    // Both decide what to SHOW. Neither may decide whether the review found
    // anything, or a re-review that repeats an unresolved HIGH reads as clean
    // and approves the new head. Every review after the first is a re-review.
    const foundBeforeDedup = {
      hasCritical: allParsedFindings.some((f) => f.severity === "🔴"),
      hasHigh: allParsedFindings.some((f) => f.severity === "🟠"),
      hasMedium: allParsedFindings.some((f) => f.severity === "🟡"),
    };

    // Hard dedup: remove findings that match prior bot comments, summary table findings,
    // or dismissed DB findings by file proximity + keyword overlap.
    if (isReReview && (botComments.length > 0 || priorSummaryTableFindings.length > 0 || dismissedDbFindings.length > 0)) {
      const priorFromComments: PriorFinding[] = botComments.map((c) => ({
        filePath: c.path,
        line: c.line ?? 0,
        title: c.body.split("\n").filter((l) => l.trim())[0] ?? "",
        keywords: extractKeywords(c.body),
      }));
      const priorFromDb: PriorFinding[] = dismissedDbFindings
        .filter((f) => f.filePath)
        .map((f) => ({
          filePath: f.filePath!,
          line: f.lineNumber ?? 0,
          title: f.title,
          keywords: extractKeywords(`${f.title} ${f.description ?? ""}`),
        }));
      // Merge and deduplicate prior findings by file+line
      const seenPriorKeys = new Set<string>();
      const priorForDedup: PriorFinding[] = [];
      for (const p of [...priorFromComments, ...priorSummaryTableFindings, ...priorFromDb]) {
        const key = `${p.filePath}:${p.line}`;
        if (!seenPriorKeys.has(key)) {
          seenPriorKeys.add(key);
          priorForDedup.push(p);
        }
      }

      const dedupResultAll = deduplicateAgainstPrior(allParsedFindings, priorForDedup);
      const dedupResultInline = deduplicateAgainstPrior(findings, priorForDedup);

      if (dedupResultAll.removed.length > 0) {
        allParsedFindings = dedupResultAll.kept;
        findings = dedupResultInline.kept;
        console.log(
          `[reviewer] Hard dedup removed ${dedupResultAll.removed.length} findings that duplicated prior bot comments: ${dedupResultAll.removed.map((f) => `"${f.title}" (${f.filePath}:${f.startLine})`).join(", ")}`,
        );
      }
    }

    // Re-review filter: only keep critical findings on follow-up reviews.
    // This is a hard filter — prompt instructions alone are not reliable enough.
    if (isReReview) {
      const beforeReReviewFilter = allParsedFindings.length;
      allParsedFindings = allParsedFindings.filter((f) => f.severity === "🔴");
      findings = findings.filter((f) => f.severity === "🔴");
      const filtered = beforeReReviewFilter - allParsedFindings.length;
      if (filtered > 0) {
        console.log(`[reviewer] Re-review filter: removed ${filtered} non-critical findings, kept ${allParsedFindings.length}`);

        // Update the main comment to reflect filtered findings. The Score table
        // is reconciled separately below (reconcileScoreTable), once the final
        // findings are known — the prompt alone does not reliably re-score, so a
        // re-review can otherwise strip every finding here yet leave a stale
        // below-gate score table behind.
        if (reviewCommentId) {
          try {
            // Patch mainCommentBody in place (not a copy) so the score
            // reconciliation below posts on top of the patched summary instead of
            // reverting it. effectiveReviewBody (the archived, canonical text) is
            // patched the same way so evidence and posted comment never diverge;
            // both are published together later rather than here, avoiding a
            // double-publish against the same comment.
            effectiveReviewBody = mapReviewPresentation(effectiveReviewBody, presentation => presentation.replace(
              /### Findings Summary[\s\S]*?(?=\n### |\n## |<!-- OCTOPUS_FINDINGS_START -->|$)/,
              "### Findings Summary\n\nAll previously raised findings have been addressed. No critical issues found.\n",
            ));
            mainCommentBody = mainCommentBody.replace(
              /### Findings Summary[\s\S]*?(?=\n### |\n## |<!-- OCTOPUS_FINDINGS_START -->|$)/,
              "### Findings Summary\n\nAll previously raised findings have been addressed. No critical issues found.\n",
            );
            console.log(`[reviewer] Updated main comment for re-review (${allParsedFindings.length} findings remain)`);
          } catch (err) {
            console.warn("[reviewer] Failed to update main comment for re-review:", err);
          }
        }
      }
    }

    // Cap findings to top N by severity
    const maxFindings = reviewConfig.maxFindings ?? MAX_FINDINGS_PER_REVIEW;
    const { kept: cappedFindings, truncatedCount } = sortAndCapFindings(findings, maxFindings);
    findings = cappedFindings;
    if (truncatedCount > 0) {
      console.log(`[reviewer] Capped findings: showing ${findings.length} of ${findings.length + truncatedCount}`);
    }

    // Split findings: inline (above threshold) vs summary-only (below threshold).
    // Default is "low" so 🔵 findings with a mappable file:line still post inline
    // (where they're easier to act on); 💡 nits go to the collapsed summary table.
    const inlineThreshold = reviewConfig.inlineThreshold ?? "low";
    const inlineSeverities = inlineThreshold === "critical"
      ? ["🔴"]
      : inlineThreshold === "high"
        ? ["🔴", "🟠"]
        : inlineThreshold === "medium"
          ? ["🔴", "🟠", "🟡"]
          : ["🔴", "🟠", "🟡", "🔵"]; // default: low
    const inlineFindings = findings.filter((f) => inlineSeverities.includes(f.severity));

    console.log(`[reviewer] Split: ${inlineFindings.length} inline (${inlineSeverities.join(",")}), severities: ${findings.map((f) => f.severity).join(",")}`);

    const diffLines = parseDiffLines(diff);
    const inlineComments = buildInlineComments(inlineFindings, diffLines, repo.provider);
    console.log(`[reviewer] Built ${inlineComments.length} inline comments from ${inlineFindings.length} inline findings`);

    // Identify inline findings that were dropped because they couldn't map to valid diff lines.
    // These "unmappable" findings should be shown in the summary table instead of vanishing.
    const inlineCommentPaths = new Set(inlineComments.map((c) => `${c.path}:${c.line}`));
    const unmappableFindings = inlineFindings.filter((f) => {
      // A finding is unmappable if none of its lines ended up in an inline comment
      for (let l = f.startLine; l <= f.endLine; l++) {
        if (inlineCommentPaths.has(`${f.filePath}:${l}`)) return false;
      }
      return true;
    });
    if (unmappableFindings.length > 0) {
      console.log(`[reviewer] ${unmappableFindings.length} inline findings couldn't map to valid diff lines, will include in summary table`);
    }

    console.log(`[reviewer] Parsed ${allParsedFindings.length} total, ${findings.length} after filters, ${inlineComments.length} inline comments`);

    // Build artifacts in the diff are surfaced as an advisory in the review body
    // (see badFilesSection above), but they are NOT findings and must not gate the
    // check run: counting them as critical produces a contradictory "0 findings" +
    // "Critical issues found that must be fixed before merge" failure and blocks
    // legitimate commits (e.g. a GitHub Action repo committing its dist/ bundle).
    const hasCritical = findings.some((f) => f.severity === "🔴");
    const hasHigh = findings.some((f) => f.severity === "🟠");
    const hasMedium = findings.some((f) => f.severity === "🟡");

    // Reconcile the Score table with the findings the review actually surfaced.
    // Scores are holistic LLM prose that nothing else checks against the findings,
    // so a review can post a below-gate score (e.g. Code Quality 3/5 -> Overall 3/5,
    // since Overall is the lowest category) with zero findings the author can fix —
    // an unactionable score that deadlocks a 4+/5 gate, and one the re-review filter
    // above actively manufactures. When no blocking (critical/high/medium) finding
    // survived, floor the sub-gate categories. See review-helpers.reconcileScoreTable.
    // `finalizeReviewPresentation` reconciles the Score table internally
    // (review-helpers.reconcileScoreTable) once assessment is complete, so no
    // separate republish is needed here.
    ({ report: effectiveReviewBody, comment: mainCommentBody } = finalizeReviewPresentation(
      response.text, effectiveReviewBody, mainCommentBody, coverage, attemptId, { hasCritical, hasHigh, hasMedium },
    ));

    const threshold = org.checkFailureThreshold || "critical";
    const shouldRequestChanges = shouldFailReviewCheck(
      { hasCritical, hasHigh, hasMedium },
      threshold,
    );
    // APPROVE is what an automated merge waits on, so every condition below is a
    // reason NOT to emit it. Each answers a different way this review could be
    // wrong rather than clean.
    //
    //  - severities come from `foundBeforeDedup`, not from the filtered
    //    `findings`, so a re-review that found a HIGH, new or repeated, cannot
    //    read as clean.
    //  - a review without a verified assessment is UNKNOWN, not clean:
    //    `parseFindings` returns [] for a malformed or truncated response
    //    exactly as it does for a genuinely clean one, so only the recorded
    //    request, validation and completion evidence counts.
    //  - a diff that was truncated or filtered was only partly read, and
    //    approving it would vouch for files the model never saw.
    // Counted from the diff the model actually read, so a truncated diff cannot
    // make a large change look small enough to wave through.
    const addedLines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    const removedLines = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    const shape = assessChangeShape({
      filesChanged,
      linesAdded: addedLines,
      linesRemoved: removedLines,
      statedPurpose: prBody ?? '',
    });
    const approvable = mayApprove({
      optedIn: org.approveWhenClean,
      found: foundBeforeDedup,
      coverage,
      shape,
    });
    if (org.approveWhenClean && !shape.mergeableUnattended) {
      console.log(`[reviewer] not approving PR ${pr.number}: ${shape.reasons.join('; ')}`);
    }
    const reviewEvent: "COMMENT" | "REQUEST_CHANGES" | "APPROVE" = shouldRequestChanges
      ? "REQUEST_CHANGES"
      : approvable
        ? "APPROVE"
        : "COMMENT";
    if (org.approveWhenClean && !approvable && !shouldRequestChanges) {
      console.log(
        `[reviewer] not approving PR ${pr.number}: clean=${isCleanReview(foundBeforeDedup)} verified=${assessmentVerified(coverage)} wholeDiff=${readWholeDiff(coverage)}`,
      );
    }

    // Track the actual number of findings visible to the user (inline + summary table)
    // This gets set by the GitHub/Bitbucket posting logic below
    let effectiveFindingsCount = 0;

    // Resolved-count signal: only meaningful on a re-review. A prior bot
    // inline comment is considered resolved when GitHub marks it `isOutdated`
    // (the diff hunk it lived on has changed since the comment was posted).
    // First reviews never show a resolved count — there is nothing to resolve.
    const resolvedCount = isReReview ? botComments.filter((c) => c.isOutdated).length : 0;

    // Build the review summary body with non-inline findings embedded
    const buildReviewSummary = (findingsBlock: string, visibleCount: number) => {
      let header = `${coverageSummary(coverage)} ${visibleCount} finding${visibleCount !== 1 ? "s" : ""}.`;
      if (resolvedCount > 0) {
        header += ` (${resolvedCount} resolved)`;
      }
      if (reviewCommentId && pr.url) {
        header += ` | [View scores & details](${pr.url}#issuecomment-${reviewCommentId})`;
      }
      const parts = [header];
      if (findingsBlock) parts.push(findingsBlock);
      // The model is named because a review's weight depends on which model
      // produced it, and a reader cannot otherwise tell a frontier read from a
      // cheap one. It matters more, not less, when the author is also a model:
      // "approved" from a flash tier is a different claim from the same word
      // from a frontier tier.
      parts.push(
        `<sub>Reviewed by [Octopus Review](https://octopus-review.ai) using \`${reviewModel}\`.</sub>`,
      );
      return parts.join("\n\n");
    };

    // Every review below is stamped with `pr.headSha` - the commit this job was
    // claimed for and whose check run it already owns.
    //
    // Omitting it is NOT "unspecified": GitHub stamps the review with the PR's
    // head at the moment the POST lands, and a review takes minutes (model
    // calls, verification, cross-file fetches). On a PR being pushed to, that
    // routinely names a commit this review never read - so a consumer treating
    // `commit_id` as evidence of what was reviewed would read the opposite of
    // the truth.
    //
    // `pr.headSha` fails safe in both directions. If the live diff turned out
    // newer, the stamp is OLDER than the merged head and a consumer holds; if
    // the head moves afterwards, the stamp mismatches and a consumer holds.
    // Only the omitted case silently agrees with whatever is current.
    let inlineReviewSucceeded = false;
    // Anchors that reached the author outside the batch, so the summary does not repeat them.
    const postedIndividually: string[] = [];

    if (isGitHub && installationId) {
      // The row can be taken from under a worker that pg-boss timed out but did
      // not stop. Checked HERE, above the inline/summary split, because BOTH
      // branches publish: a clean review has no inline comments and so takes the
      // summary path, which is exactly the review that can carry APPROVE. A
      // fence that guards only the inline branch leaves the approval unfenced.
      // Reserved by a write, not checked by a read, and again before every provider
      // call below. Each call is bounded to a quarter of the stale window, so the
      // reservation that precedes it covers it without any renewal.
      if (!(await reserveClaim(claim))) {
        console.log(
          `[reviewer] PR ${pr.id} was re-claimed while this worker was running; not publishing`,
        );
        return;
      }
      const callMs = publicationCallTimeoutMs(computeStaleReclaimMs(queueConfig.reviewTimeoutSeconds));
      // A verdict whose outcome is unknown is never sent again here: the delayed
      // reconcile finds it, and withdraws it if its request has been replaced.
      const submitReview = async (body: string, comments: ReviewComment[]): Promise<number | null> => {
        const result = await submitVerdict({
          event: reviewEvent,
          reserve: () => reserveClaim(claim),
          record: {
            runId: reviewRunId ?? null, pullRequestId: pr.id, installationId, owner, repo: repoName, prNumber: pr.number,
            headSha: claim.headSha, reviewRequestVersion: claim.reviewRequestVersion, commitId: coverage.headSha ?? null,
          },
          send: () => ghCreatePullRequestReview(
            installationId, owner, repoName, pr.number,
            body, reviewEvent, comments, undefined, coverage.headSha ?? undefined, AbortSignal.timeout(callMs),
          ),
        });
        if (result.kind === "published") return result.reviewId;
        if (result.kind === "not-reserved") throw new ClaimLostError();
        if (result.kind === "unresolved") {
          console.warn(`[reviewer] PR ${pr.id}: review outcome unknown; it will be reconciled, not resent`);
          return null;
        }
        throw result.error;
      };

      // GitHub: use the PR review API for inline comments
      if (inlineComments.length > 0) {
        // Dedup: skip inline comments where the bot already posted on the same file+line
        const existingLocations = new Set(
          (isReReview ? allPriorReviewComments : [])
            .filter((c) => !c.inReplyToId && c.line != null && c.user === botLogin)
            .map((c) => `${c.path}:${c.line}`),
        );
        const dedupedComments = inlineComments.filter((c) => !existingLocations.has(`${c.path}:${c.line}`));
        if (dedupedComments.length < inlineComments.length) {
          console.log(`[reviewer] Deduped inline comments: ${inlineComments.length} → ${dedupedComments.length} (${inlineComments.length - dedupedComments.length} already posted)`);
        }

        // First, figure out the collapsed block for the summary (we need it before posting)
        // Include ALL inline locations (both new and already-posted) so they don't leak into summary
        const allInlinePaths = new Set(inlineComments.map((c) => `${c.path}:${c.line}`));
        const nonInlineFindings = allParsedFindings.filter((f) => {
          for (let l = f.startLine; l <= f.endLine; l++) {
            if (allInlinePaths.has(`${f.filePath}:${l}`)) return false;
          }
          return true;
        });
        // Add unmappable findings (inline-severity but couldn't map to valid diff lines) to summary
        const nonInlineWithUnmappable = [...nonInlineFindings, ...unmappableFindings.filter((uf) =>
          // Avoid duplicates: only add if not already in nonInlineFindings
          !nonInlineFindings.some((nf) => nf.filePath === uf.filePath && nf.startLine === uf.startLine && nf.title === uf.title),
        )];
        const findingsBlock = buildLowSeveritySummary(nonInlineWithUnmappable);
        // Count = inline comments that will actually be posted + findings in summary table
        const visibleFindingsCount = dedupedComments.length + nonInlineWithUnmappable.length;
        effectiveFindingsCount = visibleFindingsCount;
        const summaryLine = buildReviewSummary(findingsBlock, visibleFindingsCount);


        try {
          assertProcessingActive();
          const reviewId = await submitReview(summaryLine, dedupedComments);
          inlineReviewSucceeded = true;
          console.log(`[reviewer] PR review submitted with ${dedupedComments.length} inline comments, ${nonInlineWithUnmappable.length} in summary (${reviewEvent}), reviewId: ${reviewId ?? "unresolved"}`);

          // Match GitHub review comments to ReviewIssue records by file+line
          try {
            if (reviewId === null) throw new Error("review outcome unresolved");
            const ghComments = await ghListReviewComments(
              installationId, owner, repoName, pr.number, reviewId, AbortSignal.timeout(callMs),
            );
            const issueRecords = await prisma.reviewIssue.findMany({
              where: { pullRequestId: pr.id },
              select: { id: true, filePath: true, lineNumber: true },
            });

            for (const issue of issueRecords) {
              if (!issue.filePath) continue;
              const match = ghComments.find(
                (c) => c.path === issue.filePath && c.line === issue.lineNumber,
              );
              if (match) {
                await prisma.reviewIssue.updateMany({
                  where: { id: issue.id, pullRequest: { headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion } },
                  data: { githubCommentId: BigInt(match.id) },
                });
              }
            }
            console.log(`[reviewer] Matched ${issueRecords.filter((i) => i.filePath).length} review issues to GitHub comment IDs`);
          } catch (matchErr) {
            console.error("[reviewer] Failed to match GitHub comment IDs:", matchErr);
          }
        } catch (err) {
          if (err instanceof ReviewProcessingExpiredError || err instanceof ClaimLostError) throw err;
          console.error("[reviewer] Failed to submit inline review, retrying comments individually:", err);
          // The review endpoint rejects the whole batch when one line will not resolve, so a
          // review with real findings arrives showing none. Posted one at a time, an
          // unresolvable line costs only itself and the rest still reach the author.
          if (coverage.headSha) {
            for (const comment of dedupedComments) {
              if (!(await reserveClaim(claim))) throw new ClaimLostError();
              try {
                await ghCreateSingleReviewComment(
                  installationId, owner, repoName, pr.number,
                  { path: comment.path, line: comment.line, side: comment.side, body: comment.body },
                  coverage.headSha,
                  AbortSignal.timeout(callMs),
                );
                postedIndividually.push(`${comment.path}:${comment.line}`);
              } catch (single) {
                console.warn(`[reviewer] inline comment ${comment.path}:${comment.line} could not be posted:`, single);
              }
            }
            console.log(`[reviewer] posted ${postedIndividually.length}/${dedupedComments.length} inline comments individually`);
          }
        }
      }

      if (!inlineReviewSucceeded) {
        // All findings go into the summary since none were posted inline
        const allSummaryFindings = [...allParsedFindings, ...unmappableFindings.filter((uf) =>
          !allParsedFindings.some((af) => af.filePath === uf.filePath && af.startLine === uf.startLine && af.title === uf.title),
        )].filter((f) => {
          // A finding that reached the author inline is not also a summary row; listing it
          // twice reads as two findings.
          for (let l = f.startLine; l <= f.endLine; l++) {
            if (postedIndividually.includes(`${f.filePath}:${l}`)) return false;
          }
          return true;
        });
        const findingsBlock = buildLowSeveritySummary(allSummaryFindings);
        effectiveFindingsCount = allSummaryFindings.length;
        const summaryBody = buildReviewSummary(findingsBlock, allSummaryFindings.length);
        try {
          assertProcessingActive();
          await submitReview(summaryBody, []);
          console.log(`[reviewer] PR review submitted without inline comments, ${allSummaryFindings.length} in summary (${reviewEvent})`);
        } catch (err) {
          if (err instanceof ReviewProcessingExpiredError || err instanceof ClaimLostError) throw err;
          console.error("[reviewer] Failed to submit PR review, falling back to comment:", err);
          // Publish fallback findings with the archived result and final summary guards below.
          mainCommentBody += `\n\n${findingsBlock}`;
        }
      }
    } else if (isBitbucket || usesProjectApi) {
      // Bitbucket / GitLab / Forgejo: post inline comments individually, then a summary comment
      const failedInlineComments: ReviewComment[] = [];
      for (const comment of inlineComments) {
        assertProcessingActive();
        try {
          if (usesProjectApi) {
            await projectProvider.createInlineComment(
              org.id, projectPath, pr.number,
              comment.path, comment.line, comment.body,
            );
          } else {
            await bitbucket.createInlineComment(
              org.id, owner, repoName, pr.number,
              comment.path, comment.line, comment.body,
            );
          }
        } catch (err) {
          console.error(`[reviewer] Failed to post inline comment on ${comment.path}:${comment.line}:`, err);
          failedInlineComments.push(comment);
        }
      }
      const inlinePaths = new Set(inlineComments.map((c) => `${c.path}:${c.line}`));
      const nonInlineFindings = allParsedFindings.filter((f) => {
        for (let l = f.startLine; l <= f.endLine; l++) {
          if (inlinePaths.has(`${f.filePath}:${l}`)) return false;
        }
        return true;
      });
      // Add unmappable findings to summary (inline-severity but couldn't map to diff lines)
      // Also add findings whose inline comments failed to post
      const failedInlinePaths = new Set(failedInlineComments.map((c) => `${c.path}:${c.line}`));
      const failedInlineFindings = failedInlineComments.length > 0
        ? inlineFindings.filter((f) => {
            for (let l = f.startLine; l <= f.endLine; l++) {
              if (failedInlinePaths.has(`${f.filePath}:${l}`)) return true;
            }
            return false;
          })
        : [];
      const nonInlineWithUnmappable = [
        ...nonInlineFindings,
        ...unmappableFindings.filter((uf) =>
          !nonInlineFindings.some((nf) => nf.filePath === uf.filePath && nf.startLine === uf.startLine && nf.title === uf.title),
        ),
        ...failedInlineFindings,
      ];
      // Count only actually-posted inline comments + summary table findings
      const successfulInline = inlineComments.length - failedInlineComments.length;
      const visibleCount = successfulInline + nonInlineWithUnmappable.length;
      effectiveFindingsCount = visibleCount;
      const findingsBlock = buildLowSeveritySummary(nonInlineWithUnmappable);
      const summaryBody = `${coverageSummary(coverage)} ${visibleCount} findings.${findingsBlock ? "\n\n" + findingsBlock : ""}`;
      assertProcessingActive();
      await providerCreateComment(pr.number, summaryBody);
      const providerLabel = isForgejo ? "Forgejo" : isGitlab ? "GitLab" : "Bitbucket";
      console.log(`[reviewer] ${providerLabel} review posted with ${inlineComments.length} inline comments, ${nonInlineWithUnmappable.length} in summary`);
    }

    // Step 6: Persist parsed findings as ReviewIssue records (ALL findings, not just capped/inline)
    // Fetch prior findings BEFORE clearing so that on a re-review, a finding whose
    // content signature is unchanged inherits its user-triage state (acknowledgement,
    // feedback, tracker links, original createdAt) instead of resurfacing as brand-new.
    // This exact-signature inheritance complements the earlier fuzzy (keyword +
    // line-proximity) dedup rather than replacing it — see lib/finding-merge.ts.
    const priorIssues = await prisma.reviewIssue.findMany({
      where: { pullRequestId: pr.id },
    });

    // Persist all parsed findings (pre-filter) for dashboard/scoring. The
    // delete+create replacement happens in ONE transaction below so a failure
    // mid-way can never wipe prior findings (and their triage state) without
    // writing the replacements.
    let mergedIssues: Prisma.ReviewIssueCreateManyInput[] = [];
    let inheritedCount = 0;
    const allPersistFindings = allParsedFindings;
    if (allPersistFindings.length > 0) {
      const severityMap: Record<string, string> = {
        "🔴": "critical",
        "🟠": "high",
        "🟡": "medium",
        "🔵": "low",
        "💡": "low",
      };

      const current: Prisma.ReviewIssueCreateManyInput[] = allPersistFindings.map((f) => {
        const title = f.title.replace(/^(CRITICAL|HIGH|MEDIUM|LOW|INFO)\s*—\s*/i, "").trim();
        return {
          title,
          description: f.description || f.category,
          severity: severityMap[f.severity] ?? "medium",
          filePath: f.filePath || null,
          lineNumber: f.startLine || null,
          confidence: f.confidence ? String(f.confidence) : null,
          pullRequestId: pr.id,
          signature: findingSignature({ filePath: f.filePath || "", category: f.category, title }),
        };
      });

      const { merged, inherited } = mergeFindingsBySignature<Prisma.ReviewIssueCreateManyInput>({
        prior: priorIssues,
        current,
        inherit: inheritReviewIssueTriage,
      });
      mergedIssues = merged;
      inheritedCount = inherited;
    }

    // Keep an immutable final result before exposing completion. Retries update
    // the current PR view, but cannot erase this attempt's coverage and body.
    ({ report: effectiveReviewBody, comment: mainCommentBody } = finalizeReviewPresentation(
      response.text, effectiveReviewBody, mainCommentBody, coverage, attemptId, { hasCritical, hasHigh, hasMedium },
    ));
    assertProcessingActive();
    const promoted = await saveReviewAttempt(attemptId, pr.id, coverage, effectiveReviewBody, mergedIssues, claim);
    attemptSaved = true;

    // The final scored comment becomes visible only after its immutable outcome is durable.
    assertProcessingActive();
    if (isGitHub) {
      reviewCommentId = await publishMainComment(mainCommentBody, effectiveReviewBody, attemptId, completeReviewAdmission?.window);
    } else if (reviewCommentId) {
      await providerUpdateComment(reviewCommentId, mainCommentBody, attemptId, completeReviewAdmission?.window);
      console.log(`[reviewer] Placeholder comment updated — commentId: ${reviewCommentId}`);
    } else {
      const newCommentId = await publishMainComment(mainCommentBody, undefined, attemptId, completeReviewAdmission?.window);
      reviewCommentId = newCommentId;
      console.log(`[reviewer] New review comment created — commentId: ${newCommentId}`);
    }

    if (promoted && mergedIssues.length > 0) {
      console.log(
        `[reviewer] Saved ${mergedIssues.length} review issues to DB` +
          (inheritedCount > 0 ? ` (${inheritedCount} inherited prior triage state)` : ""),
      );
    }

    // Step 7: guard against a stale worker acting past this point.
    //
    // Conditional on the claim, not a plain update: only a write that carries the
    // condition cannot be raced. `saveReviewAttempt` already promotes the PR
    // to "completed" gated on headSha/reviewRequestVersion (a different race: is
    // the PR still the one reviewed); this gates a worker that lost the claim to
    // another server instance, so it doesn't continue to check-run updates,
    // merge-gating and notifications below for a review that isn't its own.
    const finalised = await prisma.pullRequest.updateMany({
      where: claimWhere(claim, WHILE_FINISHING),
      data: {
        status: "completed",
        reviewBody: effectiveReviewBody,
      },
    });
    if (finalised.count === 0) {
      console.log(`[reviewer] PR ${pr.id} was re-claimed; not writing a terminal status`);
      return;
    }

    // Merge-gating result, computed once and applied to whichever provider
    // supports a status check (GitHub check-run, GitLab commit status).
    const checkResult = reviewCheckResult(coverage, shouldFailReviewCheck(
      { hasCritical, hasHigh, hasMedium }, threshold,
    ), effectiveFindingsCount);
    const summaryText = checkResult.summary;

    assertProcessingActive();
    if (checkRunId && isGitHub && installationId) {
      const conclusion = checkResult.conclusion;
      await ghUpdateCheckRun(installationId, owner, repoName, checkRunId, conclusion, {
        title: checkResult.title,
        summary: summaryText,
      }, completeReviewAdmission?.window);
      console.log(`[reviewer] Check run updated — conclusion: ${conclusion} (threshold: ${threshold})`);
    }

    if (pr.headSha && usesProjectApi) {
      const state = checkResult.conclusion === "failure" ? "failed" : "success";
      await projectProvider
        .setCommitStatus(org.id, projectPath, pr.headSha, state, COMMIT_STATUS_NAME, summaryText, undefined, completeReviewAdmission?.window)
        .catch((err) => {
          assertProcessingActive();
          console.error("[reviewer] Failed to set provider commit status:", err);
        });
      console.log(`[reviewer] ${repo.provider} commit status set — state: ${state} (threshold: ${threshold})`);
    }

    if (!promoted) return;

    // Step 7: Store review in vector DB for timeline/search
    try {
      await ensureReviewCollection();
      const [reviewVector] = await createEmbeddings(
        [effectiveReviewBody.slice(0, 8000)],
        { organizationId: org.id, operation: "embedding", repositoryId: repo.id },
      );
      // Delete previous review point for this PR (re-review case)
      await deleteReviewChunksByPR(pr.id);
      await upsertReviewChunks([
        {
          id: crypto.randomUUID(),
          vector: reviewVector,
          sparseVector: generateSparseVector(effectiveReviewBody),
          payload: {
            orgId: org.id,
            repoId: repo.id,
            pullRequestId: pr.id,
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.url,
            author: pr.author,
            repoFullName: repo.fullName,
            reviewDate: new Date().toISOString().split("T")[0],
            text: effectiveReviewBody,
          },
        },
      ]);
      console.log(`[reviewer] Review stored in vector DB — prId: ${pr.id}`);
    } catch (err) {
      console.error("[reviewer] Failed to store review in vector DB:", err);
    }

    // Step 8: Store diagrams in vector DB (all mermaid blocks)
    try {
      const mermaidBlocks = extractAllMermaidBlocks(reviewBody);
      if (mermaidBlocks.length > 0) {
        await ensureDiagramCollection();
        await deleteDiagramChunksByPR(pr.id);

        const descriptions = mermaidBlocks.map((block) => {
          const nodeLabels = extractNodeLabels(block.code);
          const typeLabel = DIAGRAM_TYPE_LABELS[block.type];
          return `${typeLabel} for PR #${pr.number}: ${pr.title} in ${repo.fullName} by ${pr.author}. ${nodeLabels.join(", ")}`;
        });

        const vectors = await createEmbeddings(descriptions, {
          organizationId: org.id,
          operation: "embedding",
          repositoryId: repo.id,
        });

        const reviewDate = new Date().toISOString().split("T")[0];
        for (let i = 0; i < mermaidBlocks.length; i++) {
          await upsertDiagramChunk({
            id: crypto.randomUUID(),
            vector: vectors[i],
            sparseVector: generateSparseVector(descriptions[i]),
            payload: {
              orgId: org.id,
              repoId: repo.id,
              pullRequestId: pr.id,
              prNumber: pr.number,
              prTitle: pr.title,
              repoFullName: repo.fullName,
              author: pr.author,
              mermaidCode: mermaidBlocks[i].code,
              diagramType: mermaidBlocks[i].type,
              description: descriptions[i],
              reviewDate,
            },
          });
        }
        console.log(`[reviewer] ${mermaidBlocks.length} diagram(s) stored in vector DB — prId: ${pr.id}`);
      }
    } catch (err) {
      console.error("[reviewer] Failed to store diagrams in vector DB:", err);
    }

    await recordFirstReviewCompletion(pr.id, pr.headSha, pr.reviewRequestVersion, effectiveReviewBody, claim);
    if (!await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "completed",
      step: "completed",
    })) return;

    eventBus.emit({
      type: "review-completed",
      orgId: org.id,
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.url,
      findingsCount: effectiveFindingsCount,
      filesChanged,
    });

    console.log(`[reviewer] Review completed for PR #${pr.number}`);
  } catch (err) {
    // Not a review failure: the pull request is already parked for a retry that
    // could not be scheduled, and recording a failure here would end the run.
    if (err instanceof DeferralEnqueueError) {
      console.error(`[reviewer] PR ${pr.id} deferred but its retry was not scheduled:`, err);
      throw err;
    }
    if (adaptiveProcessingWindow
      && (adaptiveProcessingWindow.signal.aborted || adaptiveProcessingWindow.remainingMs() <= 0)) {
      err = new ReviewProcessingExpiredError();
    }
    const errorMessage =
      err instanceof Error ? err.message : "Unknown error";
    // Losing the claim ends this worker's part: the row and everything published
    // for it now belong to whoever holds it, so nothing more is written or sent.
    if (err instanceof ClaimLostError) {
      console.log(`[reviewer] PR ${pr.id} was re-claimed; stopping without publishing`);
      return;
    }
    console.error(`[reviewer] Review failed for PR #${pr.number}:`, err);

    // A deadline can expire while a completed assessment is being committed. Keep that immutable
    // record and append the interrupted processing outcome before publishing any scored completion.
    let failureAttemptId = attemptId;
    if (err instanceof ReviewProcessingExpiredError && attemptCoverage) {
      if (attemptSaved) {
        failureAttemptId = crypto.randomUUID();
        attemptCoverage.limitations.push(`Processing expired after archived assessment attempt ${attemptId}.`);
        attemptSaved = false;
      }
      markReviewAssessmentIncomplete(attemptCoverage, err.message);
    }

    // Preserve failed adapter attempts without replacing a previously saved outcome.
    if (attemptCoverage && !attemptSaved && attemptCoverage.assessment && attemptCoverage.assessment.state !== "incomplete") {
      markReviewAssessmentIncomplete(attemptCoverage, "Review processing failed or was interrupted before persistence");
    }
    const failureBody = attemptCoverage?.assessment && !attemptSaved
      ? applyReviewCoverage("## 🐙 Octopus Review\n\nAssessment failed or was interrupted. No complete assessment is available.", attemptCoverage, failureAttemptId) : null;
    // The archive is evidence and stays append-only, but everything after it
    // publishes or writes the shared row. Confirmed by a write rather than a read.
    const ownsClaim = await updateUnderClaim(claim, { updatedAt: new Date() }, WHILE_FINISHING).catch(() => false);
    if (failureBody && attemptCoverage) {
      try {
        await saveReviewAttempt(failureAttemptId, pr.id, attemptCoverage, failureBody, undefined, claim);
      } catch (e) {
        if (!(e instanceof ClaimLostError)) console.error("[reviewer] Failed to archive interrupted assessment:", e);
        else return;
      }
    }
    if (!ownsClaim) {
      console.log(`[reviewer] PR ${pr.id} was re-claimed; not publishing or recording this worker's failure`);
      return;
    }

    // Update placeholder comment with error if possible
    if (isGitHub && failureBody) {
      await publishMainComment(failureBody, failureBody, failureAttemptId).catch((e) => console.error("[reviewer] Failed to publish archived failure:", e));
    } else if (reviewCommentId) {
      await providerUpdateComment(
        reviewCommentId,
        failureBody ?? `> 🐙 **Octopus Review** encountered an error while analyzing this pull request.\n>\n> \`${errorMessage}\`\n>\n> Please try again by commenting \`${isForgejo ? "@octopus" : "@octopus-review"}\` on this PR.`,
        failureAttemptId,
      ).catch((e) => console.error("[reviewer] Failed to update placeholder with error:", e));
    }

    // Update check run as failed (GitHub only)
    if (checkRunId && isGitHub && installationId) {
      await ghUpdateCheckRun(
        installationId,
        owner,
        repoName,
        checkRunId,
        "failure",
        {
          title: "Review failed",
          summary: `Octopus Review encountered an error: ${errorMessage}`,
        },
      ).catch((e) => console.error("[reviewer] Failed to update check run:", e));
    }
    // GitLab: mark the status failed on a review error so a gated MR isn't left
    // hanging on a "running" status forever.
    if (pr.headSha && usesProjectApi) {
      await projectProvider
        .setCommitStatus(org.id, projectPath, pr.headSha, "failed", COMMIT_STATUS_NAME, `Review error: ${errorMessage}`.slice(0, 255))
        .catch((e) => console.error("[reviewer] Failed to set provider failed status:", e));
    }

    // If indexing was in progress, mark it as failed (check current DB state, not stale in-memory value)
    const repoStatusNow = await prisma.repository.findUnique({ where: { id: repo.id }, select: { indexStatus: true } }).catch(() => null);
    if (repoStatusNow?.indexStatus === "indexing") {
      await prisma.repository.update({
        where: { id: repo.id },
        data: { indexStatus: "failed" },
      }).catch((e) => console.error("[reviewer] Failed to update repo index status:", e));

      pubby.trigger(`presence-org-${org.id}`, "index-status", {
        repoId: repo.id,
        status: "failed",
      }).catch((e) => console.error("[reviewer] Pubby index-status failed trigger failed:", e));
    }

    const failedUpdate = await updateUnderClaim(claim, { status: "failed", errorMessage }, WHILE_FINISHING)
      .catch((e) => { console.error("[reviewer] Failed to update PR status:", e); return false; });
    if (!failedUpdate) return;

    await emitReviewStatus(org.id, {
      ...baseEvent,
      status: "failed",
      step: "failed",
      error: errorMessage,
    });

    eventBus.emit({
      type: "review-failed",
      orgId: org.id,
      prNumber: pr.number,
      prTitle: pr.title,
      error: errorMessage,
    });
  }
}
