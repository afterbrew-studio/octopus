import { createHash } from "node:crypto";
import { inspectReviewPatch, type ReviewFileInput } from "@/lib/review-coverage";

const fullSha = /^[0-9a-f]{40}$/;

/** Recover only whole added text files whose reconstructed bytes match Git's blob. */
export function recoverAddedGitHubTextPatch(
  file: ReviewFileInput,
  revision: { headSha: string; baseSha: string },
  section: string | undefined,
): string | undefined {
  if (!section?.endsWith("\n") || file.patch !== undefined || file.unavailable !== undefined
    || file.change !== "added" || file.previousPath !== undefined
    || !Number.isSafeInteger(file.additions) || file.additions! <= 0 || file.deletions !== 0
    || !file.blobSha || !fullSha.test(file.blobSha) || /^0+$/.test(file.blobSha)
    || [revision.headSha, revision.baseSha].some(sha => !fullSha.test(sha) || /^0+$/.test(sha))
    || file.path.length > 4096 || !/^[a-zA-Z0-9._/-]+$/.test(file.path)
    || file.path.split("/").some(part => !part || part === "." || part === "..")) return;

  const lines = section.slice(0, -1).split("\n");
  if (lines[0] !== `diff --git a/${file.path} b/${file.path}`
    || lines[1] !== "new file mode 100644"
    || lines[3] !== "--- /dev/null" || lines[4] !== `+++ b/${file.path}`) return;
  const index = /^index 0{7,40}\.\.([0-9a-f]{7,40})$/.exec(lines[2] ?? "");
  if (!index || !file.blobSha.startsWith(index[1])) return;
  // One complete added-file hunk avoids trusting arbitrary/overlapping ranges.
  if (!/^@@ -0,0 \+1(?:,[1-9]\d*)? @@(?: .*)?$/.test(lines[5] ?? "")) return;
  const patch = lines.slice(5).join("\n") + "\n";
  const parsed = inspectReviewPatch(patch);
  if (!parsed.complete || parsed.hunks.length !== 1 || parsed.additions !== file.additions
    || parsed.deletions !== 0 || parsed.hunks[0].newLines !== file.additions) return;

  let content = "";
  for (let i = 6; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("+")) content += line.slice(1) + "\n";
    else if (line === "\\ No newline at end of file" && i === lines.length - 1 && content.endsWith("\n")) content = content.slice(0, -1);
    else return;
  }
  if (content.includes("\0")) return;
  const blob = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
  return blob === file.blobSha ? patch : undefined;
}
