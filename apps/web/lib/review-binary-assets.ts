import { createHash } from "node:crypto";
import { indexGitHubDiffSections } from "@/lib/github-diff-sections";

const legacyPolicy = "github-binary-png-v1" as const;
const policy = "github-binary-assets-v2" as const;
const assetKinds = { png: "image", jpg: "image", jpeg: "image", ttf: "font", woff2: "font", zip: "archive" } as const;
type AssetKind = typeof assetKinds[keyof typeof assetKinds];
const fullSha = /^[0-9a-f]{40}$/;
const prefix = /^[0-9a-f]{7,40}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

type Revision = { provider: string; headSha: string | null; baseSha: string | null };
type File = { path: string; previousPath?: string; change: string; patch?: string; additions?: number; deletions?: number; blobSha?: string; unavailable?: string };
type BinarySection = { path: string; assetKind: AssetKind; change: "added" | "modified"; newBlobPrefix: string; rawSection: string; rawSectionSha256: string };

type BinaryEvidenceFields = {
  provider: "github";
  headSha: string;
  baseSha: string;
  path: string;
  change: "added" | "modified";
  blobSha: string;
  rawSection: string;
  rawSectionSha256: string;
};

export type BinaryPngEvidence = BinaryEvidenceFields & { policy: typeof legacyPolicy };
export type BinaryAssetEvidenceV2 = BinaryEvidenceFields & { policy: typeof policy; assetKind: AssetKind };
export type BinaryAssetEvidence = BinaryPngEvidence | BinaryAssetEvidenceV2;

/** Declared scope only: extensions and Git declarations do not prove content safety. */
function assetKindForPath(path: string): AssetKind | undefined {
  const extension = /^[a-zA-Z0-9._/-]+\.([a-zA-Z0-9]+)$/.exec(path)?.[1].toLowerCase();
  if (path.length > 4096 || !extension || !Object.hasOwn(assetKinds, extension)
    || !path.split("/").every(part => part !== "" && part !== "." && part !== "..")) return;
  return assetKinds[extension as keyof typeof assetKinds];
}

/** Accept only complete ordinary-file declarations, never a marker in a hunk. */
function parseBinarySection(rawSection: string): BinarySection | undefined {
  const lines = rawSection.replace(/\n$/, "").split("\n");
  const paths = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0] ?? "");
  if (!paths || paths[1] !== paths[2]) return;
  const path = paths[2];
  const assetKind = assetKindForPath(path);
  if (!assetKind) return;
  const added = lines.length === 4 && lines[1] === "new file mode 100644";
  const modified = lines.length === 3;
  if (!added && !modified) return;
  const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)( 100644)?$/.exec(lines[added ? 2 : 1]);
  if (!index || !prefix.test(index[1]) || !prefix.test(index[2]) || /^0+$/.test(index[2])) return;
  if (added) {
    if (!/^0+$/.test(index[1]) || index[3] !== undefined) return;
  } else if (/^0+$/.test(index[1]) || index[1].startsWith(index[2]) || index[2].startsWith(index[1]) || index[3] !== " 100644") return;
  if (lines.at(-1) !== `Binary files ${added ? "/dev/null" : `a/${path}`} and b/${path} differ`) return;
  return { path, assetKind, change: added ? "added" : "modified", newBlobPrefix: index[2], rawSection, rawSectionSha256: digest(rawSection) };
}

/** Index once; any duplicate old/new path invalidates its candidate evidence. */
export function indexGitHubBinarySections(rawDiff: string): Map<string, BinarySection> {
  const candidates = new Map<string, BinarySection>();
  for (const section of indexGitHubDiffSections(rawDiff).values()) {
    const parsed = parseBinarySection(section);
    if (parsed) candidates.set(parsed.path, parsed);
  }
  return candidates;
}

/** Bind a provider declaration to independently fetched file/revision metadata. */
function bindBinaryEvidence(file: File, revision: Revision, section: BinarySection | undefined): BinaryEvidenceFields | undefined {
  if (!section || revision.provider !== "github" || !revision.headSha || !revision.baseSha
    || !fullSha.test(revision.headSha) || !fullSha.test(revision.baseSha)
    || /^0+$/.test(revision.headSha) || /^0+$/.test(revision.baseSha)
    || file.previousPath !== undefined || file.patch !== undefined || file.unavailable !== undefined
    || file.additions !== 0 || file.deletions !== 0 || !file.blobSha || !fullSha.test(file.blobSha)
    || file.path !== section.path || file.change !== section.change || !file.blobSha.startsWith(section.newBlobPrefix)) return;
  return {
    provider: "github", headSha: revision.headSha, baseSha: revision.baseSha,
    path: file.path, change: section.change, blobSha: file.blobSha,
    rawSection: section.rawSection, rawSectionSha256: section.rawSectionSha256,
  };
}

/** Historical v1 entry points retain the original PNG-only scope and receipt shape. */
export function indexGitHubBinaryPngSections(rawDiff: string): Map<string, BinarySection> {
  return new Map([...indexGitHubBinarySections(rawDiff)].filter(([path]) => /\.png$/i.test(path)));
}

export function createBinaryPngEvidence(file: File, revision: Revision, section: BinarySection | undefined): BinaryPngEvidence | undefined {
  if (!section || !/\.png$/i.test(section.path)) return;
  const fields = bindBinaryEvidence(file, revision, section);
  return fields ? { policy: legacyPolicy, ...fields } : undefined;
}

export function validateBinaryPngEvidence(file: File, revision: Revision, evidence: BinaryPngEvidence | undefined): BinaryPngEvidence | undefined {
  if (!evidence || typeof evidence.rawSection !== "string") return;
  const verified = createBinaryPngEvidence(file, revision, parseBinarySection(evidence.rawSection));
  if (!verified || (Object.keys(verified) as (keyof BinaryPngEvidence)[]).some(key => evidence[key] !== verified[key])) return;
  return verified;
}

export function createBinaryAssetEvidence(file: File, revision: Revision, section: BinarySection | undefined): BinaryAssetEvidenceV2 | undefined {
  const fields = bindBinaryEvidence(file, revision, section);
  return fields && section ? { policy, assetKind: section.assetKind, ...fields } : undefined;
}

/** Revalidate the declared version without upgrading historical receipts. */
export function validateBinaryAssetEvidence(file: File, revision: Revision, evidence: BinaryAssetEvidence | undefined): BinaryAssetEvidence | undefined {
  if (evidence?.policy === legacyPolicy) return validateBinaryPngEvidence(file, revision, evidence);
  if (evidence?.policy !== policy || typeof evidence.rawSection !== "string") return;
  const verified = createBinaryAssetEvidence(file, revision, parseBinarySection(evidence.rawSection));
  if (!verified || Object.keys(evidence).length !== Object.keys(verified).length
    || (Object.keys(verified) as (keyof BinaryAssetEvidenceV2)[]).some(key => evidence[key] !== verified[key])) return;
  return verified;
}
