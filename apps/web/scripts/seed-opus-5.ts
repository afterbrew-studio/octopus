/**
 * Add the Claude Opus 5 review model to a LIVE database (#opus-5 launch).
 *
 * The canonical model list lives in packages/db/prisma/seed.ts (which Opus 5 is
 * now part of), but that seed does a destructive availableModel.deleteMany()
 * reseed — unsafe against a populated prod DB. This is the idempotent upsert to
 * apply just this one row to an already-seeded database without wiping the rest.
 *
 * Premium / deep-review tier: isPlatformDefault stays false (default remains the
 * cheaper Sonnet tier). Pricing matches Anthropic's list ($5 / $25 per 1M) and
 * the fallback in lib/cost.ts. Safe to re-run.
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
