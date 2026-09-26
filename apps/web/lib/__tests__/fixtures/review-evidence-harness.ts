import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { ReviewCoverage } from "../../review-coverage";
import type { InlineFinding } from "../../review-dedup";

mock.module("server-only", () => ({}));
let responseText = "";
let received: unknown;
let sdkCalls = 0;
class FakeOpenAI {
  chat = { completions: { create: async (request: unknown) => {
    received = request;
    sdkCalls++;
    return { choices: [{ message: { content: responseText }, finish_reason: "stop" }] };
  } } };
}
mock.module("openai", () => ({ default: FakeOpenAI }));

type Row = { id: string; pullRequestId: string; headSha: string; baseSha: string; coverage: ReviewCoverage; reviewBody: string };
type Issue = { title: string; description: string; severity: string; pullRequestId: string; confidence: string; filePath: string; lineNumber: number };
const rows = new Map<string, Row>();
let current: Record<string, unknown> = {};
let issues: Issue[] = [];
const db = {
  reviewAttempt: {
    createMany: async ({ data }: { data: Row[] }) => {
      if (rows.has(data[0].id)) return { count: 0 };
      rows.set(data[0].id, structuredClone(data[0]));
      return { count: 1 };
    },
    findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id),
  },
  pullRequest: { updateMany: async ({ data }: { data: Record<string, unknown> }) => {
    current = structuredClone(data);
    return { count: 1 };
  } },
  reviewIssue: {
    deleteMany: async () => { issues = []; return { count: 0 }; },
    createMany: async ({ data }: { data: Issue[] }) => { issues = structuredClone(data); return { count: data.length }; },
  },
};
mock.module("@octopus/db", () => ({ prisma: { ...db, $transaction: (run: (tx: typeof db) => unknown) => run(db) } }));

const { openaiProvider } = await import("../../providers/openai");
const { fetchGitHubReviewInput } = await import("../../github-review-input");
const { buildGeneratedMatcher } = await import("../../generated-files");
const { prepareReviewInput, applyReviewCoverage, reviewAssessmentComplete, reviewCheckResult, sha256 } = await import("../../review-coverage");
const { createCoveredReviewRequest } = await import("../../review-request");
const { executeCoveredReview, executeFindingsRecovery } = await import("../../review-assessment");
const { prepareRecoveredReviewPresentation, prepareReviewPresentation, finalizeReviewPresentation } = await import("../../review-presentation");
const { parseFindings, FINDINGS_START_MARKER, FINDINGS_END_MARKER } = await import("../../review-dedup");
const { stripDetailedFindings, buildInlineComments, buildLowSeveritySummary, parseDiffLines, countFindingsFromTable } = await import("../../review-helpers");
const { saveReviewAttempt } = await import("../../review-attempt");

const head = "a".repeat(40), base = "b".repeat(40);
const sqlPath = "web/drizzle/0001_example.sql";
const journalPath = "web/drizzle/meta/_journal.json";
const securityPath = "src/query.ts";
const unsupported: InlineFinding = {
  severity: "🟡", title: "Migration registration missing", filePath: sqlPath,
  startLine: 1, endLine: 1, category: "Bug", confidence: 90,
  description: `The migration is not registered in \`${journalPath}\`.`,
  suggestion: "Register this migration before deploying.",
  minimumFixScope: `Update \`${journalPath}\` to add its missing entry.`,
};
const security: InlineFinding = {
  severity: "🟠", title: "Interpolated SQL input", filePath: securityPath,
  startLine: 1, endLine: 1, category: "Security", confidence: 95, cwe: "CWE-89",
  description: "The query concatenates untrusted input into SQL.",
  suggestion: "db.query('SELECT * FROM users WHERE id = ?', [id]);",
  whyTestsDoNotAlreadyCoverThis: "The existing fixture uses numeric IDs only.",
  suggestedRegressionTest: "Reject an ID containing SQL metacharacters.",
  minimumFixScope: "Parameterize this query only.",
};
const block = (findings: unknown) => `${FINDINGS_START_MARKER}\n${JSON.stringify(findings)}\n${FINDINGS_END_MARKER}`;
function report(findings: InlineFinding[], prose = "The migration is not registered and must be fixed before merge."): string {
  const labels = ["🔴 Critical", "🟠 High", "🟡 Medium", "🔵 Low", "💡 Nit"];
  const counts = labels.map(label => `| ${label} | ${findings.filter(f => f.severity === label.split(" ")[0]).length} |`).join("\n");
  return `## 🐙 Octopus Review

### Summary
${prose}

### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 3/5 | Parameterize the supplied query |
| Code Quality | 3/5 | Registration must be fixed |
| Performance | 5/5 | No performance defect observed |
| Error Handling | 5/5 | Explicit error handling |
| Consistency | 5/5 | Consistent with surrounding code |
| **Overall** | **3/5** | Address the stated defects |

### Checklist
- [ ] Fix registration before deployment.

### Findings Summary
| Severity | Count |
| --- | --- |
${counts}

${block(findings)}

Last reviewed commit: ${head}
`;
}

async function plan(excluded = true) {
  // The registered entry is present in the provider's exact-head fixture but
  // excluded from the model's changed-hunk input by the actual generated policy.
  const journal = excluded
    ? '{"entries":[{"tag":"0001_example"}],"fixtureEvidence":"registered-at-head"}'
    : '{"entries":[]}';
  const files = [
    { filename: sqlPath, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+CREATE TABLE examples (id integer);\n" },
    { filename: securityPath, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+db.query('SELECT * FROM users WHERE id = ' + id);\n" },
    { filename: journalPath, status: "added", additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+${journal}\n` },
  ];
  const input = await fetchGitHubReviewInput({
    expectedHead: head, maxPatchChars: 10000, fetchDiff: async () => "",
    readJson: async suffix => suffix ? files : { head: { sha: head }, base: { sha: base }, changed_files: files.length },
  });
  const prepared = prepareReviewInput(input.input, { maxChars: 10000, ...(excluded ? { generated: buildGeneratedMatcher() } : {}) });
  prepared.coverage.reviewRequestVersion = 1;
  assert.equal(prepared.coverage.complete, true);
  assert.equal(prepared.coverage.files.find(file => file.path === journalPath)?.state, excluded ? "excluded" : "supplied");
  assert.equal(prepared.diff.includes(journal), !excluded);
  return prepared;
}

const scenarios = [
  { name: "recovery-malformed-primary-retained", body: report([unsupported, security], "Two findings require attention.").replace(block([unsupported, security]), block([security])), excluded: true, valid: false, kept: [security], recovery: [unsupported, null] },
  { name: "recovery-malformed-trailing-envelope", body: report([unsupported, security], "Two findings require attention.").replace(block([unsupported, security]), block([security])), excluded: true, valid: false, kept: [security], recovery: [unsupported], rawRecovery: block([unsupported]) + "\n```json\n[null,]\n```" },
  { name: "recovery-malformed-set", body: report([unsupported, security], "Two findings require attention.").replace(block([unsupported, security]), block([])), excluded: true, valid: false, kept: [], recovery: [unsupported, security, null] },
  ...[block([unsupported, security]), "```json\n" + JSON.stringify([unsupported, security]) + "\n```"].map((rawRecovery, index) => ({ name: `recovery-valid-envelope-${index}`, body: report([unsupported, security], "Two findings require attention.").replace(block([unsupported, security]), block([])), excluded: true, valid: false, kept: [security], recovery: [unsupported, security], rawRecovery })),
  { name: "recovery-excluded-claim", body: report([unsupported, security], "Two findings require attention.").replace(block([unsupported, security]), block([])), excluded: true, valid: false, kept: [security], recovery: [unsupported, security] },
  { name: "excluded-subject", body: report([unsupported, security]), excluded: true, valid: true, kept: [security] },
  { name: "excluded-only-claim", body: report([unsupported], "> ✅ No new issues detected since the last review."), excluded: true, valid: true, kept: [] },
  { name: "score-only-claim", body: report([security], "Parameterize the supplied query.").replace("Registration must be fixed", `\`${journalPath}\` is not visible`), excluded: true, valid: true, kept: [security] },
  { name: "supplied-subject", body: report([unsupported, security]), excluded: false, valid: true, kept: [unsupported, security] },
  { name: "malformed-array", body: report([unsupported, security]).replace(block([unsupported, security]), block([unsupported, security, null])), excluded: true, valid: false, kept: [] },
  { name: "malformed-json", body: report([unsupported, security]).replace(block([unsupported, security]), block([unsupported, security]).replace("[", "[,")), excluded: true, valid: false, kept: [] },
  { name: "unterminated-block", body: report([unsupported, security]).replace(FINDINGS_END_MARKER, ""), excluded: true, valid: false, kept: [] },
  { name: "multiple-blocks", body: report([unsupported, security]) + "\n" + block([unsupported]), excluded: true, valid: false, kept: [] },
];

for (const scenario of scenarios) {
  const input = await plan(scenario.excluded);
  const filesBefore = structuredClone(input.coverage.files);
  responseText = scenario.body;
  const beforeCalls = sdkCalls;
  const request = createCoveredReviewRequest({ model: "gpt-test", system: "Trusted review template", number: 1, title: "Synthetic migration", author: "fixture", diff: input.diff, coverage: input.coverage, comment: "", repoConfig: "" });
  await executeCoveredReview(request, input.coverage, "evidence-fixture-v1", params => openaiProvider.create(params, "fixture-key"));
  assert.equal(sdkCalls, beforeCalls + 1);
  const actual = received as { messages: { role: string; content: string }[] };
  const userContent = actual.messages.find(message => message.role === "user")!.content;
  const visibility = JSON.parse(userContent.split("REVIEW INPUT VISIBILITY")[1].split("\n")[1]);
  assert.deepEqual(visibility.map((file: { path: string; state: string }) => [file.path, file.state]), input.coverage.files.map(file => [file.path, file.state]));
  assert.ok(!userContent.includes("registered-at-head"));
  assert.equal(input.coverage.assessment?.state, scenario.valid ? "completed" : "incomplete");
  const originalFailure = input.coverage.assessment?.reason;
  const originalReceipt = structuredClone(input.coverage.assessment!);
  assert.equal(originalReceipt.responseSha256, sha256(scenario.body));
  assert.equal(originalReceipt.requests[0].sha256, sha256(JSON.stringify(received)));
  assert.equal(originalReceipt.requests[0].inputPreserved, true);

  let prepared = prepareReviewPresentation(scenario.body, input.coverage);
  if (scenario.recovery) {
    responseText = scenario.rawRecovery ?? JSON.stringify(scenario.recovery);
    const recovered = await executeFindingsRecovery({ model: "gpt-test", reviewBody: prepared, parsedFindingsCount: parseFindings(prepared).length, tableFindingsTotal: 2 }, input.coverage, params => openaiProvider.create(params, "fixture-key"));
    assert.deepEqual(recovered.findings, scenario.name.startsWith("recovery-malformed-") ? null : scenario.recovery);
    if (scenario.name.startsWith("recovery-malformed-")) {
      assert.equal(input.coverage.assessment!.recoveries![0].state, "incomplete");
      assert.ok(input.coverage.assessment!.reason.includes("Findings recovery JSON set is malformed"));
    }
    const recoveryReceipt = structuredClone(input.coverage.assessment!.recoveries![0]);
    const contained = prepareRecoveredReviewPresentation(prepared, recovered.text, [...parseFindings(prepared), ...(recovered.findings ?? [])], input.coverage);
    assert.notEqual(contained, null);
    prepared = contained!;
    const combinedReason = input.coverage.assessment!.reason;
    assert.ok(combinedReason.startsWith(originalFailure!), "recovery retains the original format failure first");
    assert.ok(combinedReason.includes("Excluded-input claims require verification"));
    prepareRecoveredReviewPresentation(prepared, recovered.text, [...parseFindings(prepared), ...(recovered.findings ?? [])], input.coverage);
    assert.equal(input.coverage.assessment!.reason, combinedReason, "repeated containment does not duplicate diagnostics");
    assert.deepEqual(input.coverage.assessment!.recoveries![0], recoveryReceipt);
    assert.equal(recoveryReceipt.responseSha256, sha256(responseText));
    assert.equal(recoveryReceipt.requests[0].sha256, sha256(JSON.stringify(received)));
    assert.equal(recoveryReceipt.completion?.state, "completed");
  }
  const findings = parseFindings(prepared);
  assert.deepEqual(findings, scenario.kept, scenario.name);
  assert.equal(countFindingsFromTable(prepared), findings.length, scenario.name);
  assert.deepEqual(input.coverage.files, filesBefore, "semantic verification must not alter supplied/excluded inventory");
  assert.equal(input.coverage.complete, true, "preserve input completeness independently from semantic and format assessment failures");
  assert.equal(input.coverage.assessment?.state, scenario.excluded ? "incomplete" : "completed");
  assert.equal(reviewAssessmentComplete(input.coverage), !scenario.excluded);
  if (!scenario.valid) assert.ok(input.coverage.assessment!.reason.startsWith(originalFailure!), "format failure remains independent and first");
  assert.deepEqual(input.coverage.assessment?.requests, originalReceipt.requests);
  assert.equal(input.coverage.assessment?.responseSha256, originalReceipt.responseSha256);
  assert.deepEqual(input.coverage.assessment?.completion, originalReceipt.completion);

  const flags = { hasCritical: findings.some(f => f.severity === "🔴"), hasHigh: findings.some(f => f.severity === "🟠"), hasMedium: findings.some(f => f.severity === "🟡") };
  const covered = applyReviewCoverage(prepared, input.coverage, scenario.name);
  const final = finalizeReviewPresentation(scenario.body, covered, stripDetailedFindings(covered), input.coverage, scenario.name, flags);
  const inline = buildInlineComments(findings, parseDiffLines(input.diff));
  const summary = buildLowSeveritySummary(findings);
  assert.equal(inline.length, scenario.kept.length);
  const check = reviewCheckResult(input.coverage, false, findings.length);
  assert.equal(check.conclusion, scenario.excluded ? "failure" : "success");
  if (scenario.excluded) {
    for (const output of [final.report, final.comment, summary, ...inline.map(comment => comment.body)]) {
      assert.ok(!output.includes(unsupported.title), scenario.name);
      assert.ok(!output.includes(unsupported.description), scenario.name);
      assert.ok(!output.includes(unsupported.suggestion!), scenario.name);
      assert.ok(!output.includes(unsupported.minimumFixScope!), scenario.name);
      assert.ok(!output.includes("Fix registration before deployment"), scenario.name);
      assert.ok(!output.includes("No new issues detected"), scenario.name);
      assert.ok(!/[1-5]\/5/.test(output), scenario.name);
    }
    assert.ok(final.report.includes("Verification gaps"));
    assert.ok(final.report.includes("Generated-file policy"));
    assert.ok(final.report.includes("not assessed"));
    if (scenario.kept.length) {
      assert.deepEqual(parseFindings(final.report), scenario.kept);
      assert.ok(`${final.comment}\n${summary}`.includes(security.description));
      assert.ok(summary.includes(security.title));
      assert.ok(inline[0].body.includes(security.description));
    } else {
      assert.equal(countFindingsFromTable(final.report), 0);
      assert.deepEqual(parseFindings(final.report), []);
    }
  } else {
    assert.ok(final.report.includes("**3/5**"), "retain the real supplied-subject penalty");
    assert.ok(final.report.includes(unsupported.description));
    assert.ok(!final.report.includes("Verification gaps"));
  }
  const persisted = findings.map(f => ({ pullRequestId: "pr", title: f.title, description: f.description, severity: f.severity, confidence: String(f.confidence), filePath: f.filePath, lineNumber: f.startLine }));
  assert.equal(await saveReviewAttempt(scenario.name, "pr", input.coverage, final.report, persisted), true);
  assert.deepEqual(issues, persisted);
  assert.equal(current.reviewBody, final.report);
  assert.deepEqual(rows.get(scenario.name)?.coverage, JSON.parse(JSON.stringify(input.coverage)));
  assert.equal(rows.get(scenario.name)?.reviewBody, final.report);
  assert.equal(await saveReviewAttempt(scenario.name, "pr", input.coverage, final.report, persisted), false);
  const changed = structuredClone(input.coverage);
  changed.assessment!.responseSha256 = "f".repeat(64);
  await assert.rejects(saveReviewAttempt(scenario.name, "pr", changed, final.report), /identity conflict/);
  if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
    await Bun.write(`${process.env.REVIEW_TEST_EVIDENCE_DIR}/evidence-${scenario.name}.json`, JSON.stringify({ boundary: "Actual GitHub input adapter, provider adapter, assessment, presentation, parser, native check and immutable save; synthetic input, mocked SDK/database", request: received, originalResponseSha256: originalReceipt.responseSha256, coverage: input.coverage, ...final, inline, summary, check, archive: rows.get(scenario.name), issues }, null, 2));
  }
}

console.log("PASS excluded-input evidence integration");
