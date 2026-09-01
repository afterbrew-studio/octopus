import "server-only";

import { getFileContent } from "@/lib/github";
import { REVIEW_CONFIG_PATH, parseReviewConfig, type ReviewConfig } from "@/lib/review-config-shared";

export {
  REVIEW_CONFIG_PATH,
  MAX_REVIEW_LABELS,
  parseReviewConfig,
  labelAsksForReview,
  type ReviewConfig,
} from "@/lib/review-config-shared";

/**
 * Read the config from the repository's default branch.
 *
 * Absent or unreadable means no label trigger, and every other behaviour is unchanged. A
 * repository that has never heard of this file keeps working exactly as before.
 */
export async function fetchReviewConfig(args: {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
}): Promise<ReviewConfig> {
  // The default branch, never the pull request's head. The head is author-controlled, so
  // reading the trigger from it would let a pull request add its own review label.
  const raw = await getFileContent(
    args.installationId,
    args.owner,
    args.repo,
    args.defaultBranch,
    REVIEW_CONFIG_PATH,
  );
  return parseReviewConfig(raw);
}
