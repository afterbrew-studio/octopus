/**
 * Publish a markdown blog post to Octopus via the authenticated POST /api/blog
 * endpoint (public API — no DB access needed; prod DB is VPN-only).
 *
 *   Dry run (default, no write — prints the parsed payload):
 *     BLOG_API_TOKEN=... bun run apps/web/scripts/publish-blog-post.ts <file.md>
 *   Create as draft:
 *     BLOG_API_TOKEN=... bun run apps/web/scripts/publish-blog-post.ts <file.md> --status=draft
 *   Create and publish:
 *     BLOG_API_TOKEN=... bun run apps/web/scripts/publish-blog-post.ts <file.md> --status=published
 *
 * The file is markdown with a simple `---` frontmatter block:
 *   title, slug, excerpt, category, authorName, coverImageUrl (scalars)
 *   tags (inline array: [A, B, C])
 *
 * Env: BLOG_API_TOKEN (required), OCTOPUS_API_URL (default https://octopus-review.ai).
 */
import { readFileSync } from "node:fs";

type Frontmatter = {
  title?: string;
  slug?: string;
  excerpt?: string;
  category?: string;
  authorName?: string;
  coverImageUrl?: string;
  tags?: string[];
};

/** Parse a leading `---` frontmatter block. Returns the fields + the remaining body. */
export function parseFrontmatter(raw: string): { data: Frontmatter; content: string } {
  const text = raw.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { data: {}, content: text.trim() };
  // Match the block between the first pair of --- fences.
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { data: {}, content: text.trim() };
  const block = text.slice(3, end).trim();
  const content = text.slice(text.indexOf("\n", end + 1) + 1).trim();

  const data: Frontmatter = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    if (key === "tags") {
      data.tags = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else {
      (data as Record<string, string>)[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { data, content };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const status = args.find((a) => a.startsWith("--status="))?.split("=")[1] ?? "dry";

  if (!file) {
    console.error("Usage: publish-blog-post.ts <file.md> [--status=dry|draft|published]");
    process.exit(1);
  }
  if (!["dry", "draft", "published"].includes(status)) {
    console.error(`Invalid --status=${status} (expected dry | draft | published)`);
    process.exit(1);
  }

  const { data, content } = parseFrontmatter(readFileSync(file, "utf8"));
  if (!data.title || !content) {
    console.error("Post needs a `title` in frontmatter and a non-empty body.");
    process.exit(1);
  }

  const payload = {
    title: data.title,
    slug: data.slug,
    content,
    excerpt: data.excerpt,
    coverImageUrl: data.coverImageUrl ?? null,
    authorName: data.authorName ?? "Octopus Team",
    tags: data.tags,
    category: data.category,
    generateSeo: true,
    status: status === "dry" ? "draft" : status,
  };

  const API_URL = (process.env.OCTOPUS_API_URL ?? "https://octopus-review.ai").replace(/\/$/, "");
  console.log(`[publish-blog] Mode: ${status === "dry" ? "DRY RUN (no write)" : status.toUpperCase()} · ${API_URL}`);
  console.log(`  title: ${payload.title}`);
  console.log(`  slug:  ${payload.slug ?? "(auto from title)"}`);
  console.log(`  tags:  ${payload.tags?.join(", ") ?? "(none)"} · category: ${payload.category ?? "(none)"}`);
  console.log(`  body:  ${content.length} chars`);

  if (status === "dry") {
    console.log("Dry run — nothing posted. Re-run with --status=draft or --status=published to write.");
    return;
  }

  const TOKEN = process.env.BLOG_API_TOKEN;
  if (!TOKEN) {
    console.error("BLOG_API_TOKEN is required to write.");
    process.exit(1);
  }
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  // Upsert by slug: a POST with an existing slug 409s, so re-running (e.g. draft
  // then published, the documented promote flow) must PATCH the existing post
  // instead. Look across all statuses so a hidden draft is found too.
  const existingId = payload.slug ? await findPostIdBySlug(API_URL, headers, payload.slug) : null;

  if (existingId) {
    const res = await fetch(`${API_URL}/api/blog`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        id: existingId,
        title: payload.title,
        content,
        excerpt: payload.excerpt,
        coverImageUrl: payload.coverImageUrl,
        tags: payload.tags,
        category: payload.category,
        status: payload.status,
      }),
    });
    const t = await res.text();
    if (!res.ok) {
      console.error(`PATCH /api/blog failed: ${res.status} ${res.statusText}\n${t}`);
      process.exit(1);
    }
    const updated = JSON.parse(t) as { slug?: string; status?: string };
    console.log(`✓ updated → ${updated.status ?? payload.status}: ${API_URL}/blog/${updated.slug ?? payload.slug}`);
    return;
  }

  const res = await fetch(`${API_URL}/api/blog`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    console.error(`POST /api/blog failed: ${res.status} ${res.statusText}\n${bodyText}`);
    process.exit(1);
  }
  const created = JSON.parse(bodyText) as { slug?: string; status?: string };
  console.log(`✓ created → ${created.status ?? status}: ${API_URL}/blog/${created.slug ?? payload.slug}`);
}

/** Find a post id by exact slug across all statuses (drafts included); null if none. */
async function findPostIdBySlug(
  apiUrl: string,
  headers: Record<string, string>,
  slug: string,
): Promise<string | null> {
  for (let page = 1; page <= 500; page++) {
    const res = await fetch(`${apiUrl}/api/blog?limit=50&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GET /api/blog failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as {
      posts?: Array<{ id: string; slug: string }>;
      pagination?: { totalPages?: number };
    };
    const hit = data.posts?.find((p) => p.slug === slug);
    if (hit) return hit.id;
    const totalPages = Number(data?.pagination?.totalPages);
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
  }
  return null;
}

// Only run when executed directly (not when imported by the test).
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
