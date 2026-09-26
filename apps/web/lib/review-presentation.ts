import type { InlineFinding } from "@/lib/review-dedup";
import type { ReviewCoverage } from "@/lib/review-coverage";
import { applyReviewCoverage, reviewAssessmentComplete } from "@/lib/review-coverage";
import { validReviewFindings, markReviewAssessmentIncomplete } from "@/lib/review-assessment";
import { normalizeLastReviewedCommit, normalizeScoreDenominators, reconcileScoreTable } from "@/lib/review-helpers";
import { sanitizeMermaidInMarkdown } from "@/lib/mermaid-utils";
import { containExcludedInputClaims, parseReviewFindingsSet, recoveryFindingsBody, parseRecoveryFindingsSet, excludedInputGapReport } from "@/lib/review-evidence";

function findingsBlocks(body: string): string[] {
  return body.match(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g) ?? [];
}

export function mapReviewPresentation(body: string, transform: (presentation: string) => string): string {
  const blocks = findingsBlocks(body);
  const presentation = body.replace(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g, "");
  const transformed = transform(presentation);
  if (blocks.length === 0) return transformed;
  const footer = /\n*Last reviewed commit: [0-9a-f]{40}\s*$/i.exec(transformed)?.[0] ?? "";
  return [footer ? transformed.slice(0, -footer.length).trimEnd() : transformed.trimEnd(), ...blocks, footer.trim()].filter(Boolean).join("\n\n");
}

export function enforceReviewFindingsIntegrity(original: string, current: string, coverage: ReviewCoverage, checkSummary = false): void {
  if (coverage.assessment?.state !== "completed") return;
  const before = findingsBlocks(original);
  const after = findingsBlocks(current);
  if (before.length === 1 && after.length === 1 && before[0] === after[0]
    && (!checkSummary || validReviewFindings(current))) return;
  markReviewAssessmentIncomplete(coverage, "Validated findings were lost, changed or inconsistent during report preparation");
}

function markExcludedInputAssessment(coverage: ReviewCoverage): void {
  const reason = "Excluded-input claims require verification; no valid overall assessment";
  const previous = coverage.assessment;
  if (previous?.state === "incomplete" && previous.reason.includes(reason)) return;
  markReviewAssessmentIncomplete(coverage, previous?.state === "incomplete"
    ? `${previous.reason}; ${reason}` : reason);
}

export function prepareReviewPresentation(body: string, coverage: ReviewCoverage): string {
  const contained = containExcludedInputClaims(body, coverage);
  if (contained.paths.length > 0) markExcludedInputAssessment(coverage);
  const cleaned = mapReviewPresentation(contained.body, presentation => {
    let result = presentation.replace(/([^\n])```(\n|$)/g, "$1\n```$2")
      .replace(/```([^`\n\sa-z])/g, "```\n\n$1");
    result = normalizeScoreDenominators(result);
    result = result.replace(/### Diagram\s*\n[\s\S]*?(?=\n### |\n## |$)/, section => {
      const content = /```mermaid\s*\n([\s\S]*?)```/.exec(section)?.[1]?.trim() ?? "";
      return content.length > 10 ? section : "";
    });
    return normalizeLastReviewedCommit(sanitizeMermaidInMarkdown(result), coverage.headSha);
  });
  enforceReviewFindingsIntegrity(body, cleaned, coverage, true);
  return cleaned;
}

export function finalizeReviewPresentation(
  original: string, report: string, comment: string, coverage: ReviewCoverage, attemptId: string,
  findings: { hasCritical: boolean; hasHigh: boolean; hasMedium: boolean },
): { report: string; comment: string } {
  enforceReviewFindingsIntegrity(original, report, coverage);
  const finalize = (body: string) => mapReviewPresentation(body, presentation => {
    const assessed = reviewAssessmentComplete(coverage) && coverage.assessment?.state === "completed" ? reconcileScoreTable(presentation, findings)
      : applyReviewCoverage(presentation.replace(/### Review coverage[\s\S]*?\nAssessment: [^\n]*\n\n/, ""), coverage, attemptId);
    return normalizeLastReviewedCommit(assessed, coverage.headSha);
  });
  return { report: finalize(report), comment: finalize(comment) };
}

export function prepareRecoveredReviewPresentation(body: string, rawRecovery: string, findings: InlineFinding[], coverage: ReviewCoverage): string | null {
  const recoveryBody = recoveryFindingsBody(rawRecovery);
  if (parseRecoveryFindingsSet(rawRecovery) === null) {
    const rejected = containExcludedInputClaims(recoveryBody, coverage);
    if (rejected.paths.length === 0) return null;
    markExcludedInputAssessment(coverage);
    return prepareReviewPresentation(excludedInputGapReport(rejected.paths, body), coverage);
  }
  const intact = parseReviewFindingsSet(body) !== null;
  const presentation = intact ? body.replace(/<!-- OCTOPUS_FINDINGS_START -->[\s\S]*?<!-- OCTOPUS_FINDINGS_END -->/g, "") : body;
  const combined = `${presentation}\n<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify(findings)}\n<!-- OCTOPUS_FINDINGS_END -->`;
  const contained = containExcludedInputClaims(combined, coverage);
  if (contained.paths.length === 0) return null;
  markExcludedInputAssessment(coverage);
  return prepareReviewPresentation(contained.body, coverage);
}
