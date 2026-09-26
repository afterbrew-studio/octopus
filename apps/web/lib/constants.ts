export const DISCORD_INVITE_URL = "https://discord.gg/qyuWTXghbS";
export const MAX_OWNED_ORGS_PER_USER = 3;
// Review output budget configuration is documented in the root .env.example.
const configuredReviewMaxTokens = Number(process.env.OCTOPUS_REVIEW_MAX_TOKENS);
export const REVIEW_MAX_TOKENS = Number.isSafeInteger(configuredReviewMaxTokens)
  && configuredReviewMaxTokens >= 1 && configuredReviewMaxTokens <= 131_072
  ? configuredReviewMaxTokens : 8192;
// Welcome credits granted once, on a user's first organization (USD).
export const WELCOME_FREE_CREDITS = 150;
