/**
 * Seed the Claude Opus 5 review model (#opus-5 launch).
 *
 * Opus 5 is offered as the PREMIUM / deep-review tier, not the platform default
 * (the default stays the cheaper Sonnet tier), so isPlatformDefault is false.
 * Pricing matches Anthropic's list ($5 / $25 per 1M) and mirrors the fallback in
 * lib/cost.ts. Idempotent — safe to re-run.
 *
 * Usage: bun run --cwd apps/web scripts/seed-opus-5.ts
 */
import { prisma } from "@octopus/db";

async function main() {
  const model = await prisma.availableModel.upsert({
    where: { modelId: "claude-opus-5" },
    update: {
      displayName: "Claude Opus 5",
      provider: "anthropic",
      category: "llm",
      inputPrice: 5,
      outputPrice: 25,
      isActive: true,
      // Premium tier — never the platform default (default stays Sonnet-tier).
      isPlatformDefault: false,
    },
    create: {
      modelId: "claude-opus-5",
      displayName: "Claude Opus 5",
      provider: "anthropic",
      category: "llm",
      inputPrice: 5,
      outputPrice: 25,
      isActive: true,
      isPlatformDefault: false,
    },
  });
  console.log(`Seeded ${model.modelId} ($${model.inputPrice}/$${model.outputPrice}, default=${model.isPlatformDefault}, active=${model.isActive})`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
