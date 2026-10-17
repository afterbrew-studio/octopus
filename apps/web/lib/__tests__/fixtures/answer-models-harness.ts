import { mock } from "bun:test";
import assert from "node:assert/strict";
import { calls, usage, reply, reset, quiet, prisma, ORG_MODEL } from "./gateway-only";

/**
 * Slack answers, knowledge enhancement, the public docs assistant and blog SEO metadata reach
 * their model through the router, so a deployment with only gateway providers never reaches a
 * vendor it has no key for. The docs assistant is the streaming path.
 */

const PLATFORM_MODEL = "acp:platform-default";
(prisma.availableModel as { findFirst: () => Promise<unknown> }).findFirst = async () => ({ modelId: PLATFORM_MODEL });

mock.module("@/lib/embeddings", () => ({ createEmbeddings: async () => [[0.1, 0.2]] }));
mock.module("@/lib/qdrant", () => ({
  searchCodeChunksAcrossRepos: async () => [], searchKnowledgeChunks: async () => [],
  searchReviewChunks: async () => [], searchChatChunks: async () => [], searchDiagramChunks: async () => [],
  ensureChatCollection: async () => {}, upsertChatChunk: async () => {},
  searchDocsChunks: async () => [], ensureDocsCollection: async () => {},
  deleteKnowledgeDocumentChunks: async () => {},
}));
mock.module("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => ({ value: "org" }) }),
}));
mock.module("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user" } }) } } }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

Object.assign(prisma, {
  repository: { findMany: async () => [], findUnique: async () => ({ reviewModelId: null }) },
  organizationMember: { findMany: async () => [], findFirst: async () => ({ id: "member" }) },
  knowledgeDocument: { findMany: async () => [] },
  pullRequest: { findMany: async () => [] },
  askOctopusSession: { create: async () => ({ id: "session" }), findUnique: async () => null },
  askOctopusMessage: { create: () => Promise.resolve({}) },
  serviceToken: {
    findUnique: async () => ({ id: "token", tokenPrefix: "oct", scopes: ["blog:create"], expiresAt: null }),
    update: () => Promise.resolve({}),
  },
  blogPost: { findFirst: async () => null, create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "post", ...data }) },
});

const noAnthropic = () => assert.equal(calls.some((call) => call.provider === "anthropic" || call.provider === "openai"), false,
  "no path reaches a provider that has no key");
const text = (stream: ReadableStream | null) => new Response(stream).text();

// Slack answers on the org's review model.
{
  reset();
  reply.text = "The build is green.";
  const posts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    posts.push(String(init?.body));
    return new Response("ok");
  }) as typeof fetch;
  const { processSlackQuestion } = await import("@/lib/slack-responder");
  await quiet(() => processSlackQuestion({ question: "is the build green?", orgId: "org", responseUrl: "https://slack.test/r", userName: "u", slackUserId: "U1" }));
  globalThis.fetch = realFetch;
  assert.deepEqual(calls, [{ provider: "opencode", model: ORG_MODEL }], "slack uses the org's review model");
  assert.deepEqual(usage, [{ model: ORG_MODEL, operation: "slack-command", provider: "opencode" }]);
  assert.match(posts[0], /The build is green\./, "the answer reaches Slack");
  noAnthropic();
}

// Knowledge enhancement on the org's review model.
{
  reset();
  reply.text = "# Rules\n- Do not log secrets.";
  const { enhanceKnowledgeContent } = await import("@/app/(app)/knowledge/actions");
  const result = await quiet(() => enhanceKnowledgeContent("dont log secrets"));
  assert.deepEqual(result, { content: "# Rules\n- Do not log secrets." });
  assert.deepEqual(calls, [{ provider: "opencode", model: ORG_MODEL }], "knowledge enhance uses the org's review model");
  assert.deepEqual(usage, [{ model: ORG_MODEL, operation: "knowledge-enhance", provider: "opencode" }]);
  noAnthropic();
}

// The docs assistant has no organization: the platform default, streamed through the router.
{
  reset();
  reply.text = "Octopus reviews pull requests.";
  const { POST } = await import("@/app/api/ask-octopus/route");
  const request = (body: unknown) => new Request("http://localhost/api/ask-octopus", {
    method: "POST", headers: { "user-agent": "Mozilla/5.0", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body),
  });
  const response = await quiet(() => POST(request({ message: "what is octopus?" })));
  const body = await text(response.body);
  assert.deepEqual(calls, [{ provider: "acp", model: PLATFORM_MODEL }], "the docs assistant uses the platform default");
  assert.match(body, /"delta":"Octopus reviews pull requests\."/, "the answer is delivered as a delta");
  assert.match(body, /\[DONE\]/);
  assert.doesNotMatch(body, /Response trimmed/, "a complete answer carries no truncation note");
  noAnthropic();

  reset();
  reply.text = "Octopus reviews";
  reply.finish = "length";
  const truncated = await text((await quiet(() => POST(request({ message: "what is octopus?" })))).body);
  assert.match(truncated, /Response trimmed/, "a gateway length stop appends the truncation note");

  reset();
  reply.error = new Error("gateway down");
  const failed = await quiet(async () => text((await POST(request({ message: "what is octopus?" }))).body));
  assert.match(failed, /Stream interrupted/, "a gateway failure ends the stream with an error event");
}

// Blog SEO metadata on the platform default, with no organization.
{
  reset();
  reply.text = '{"excerpt":"Short summary","category":"Engineering","tags":["ci","bun"]}';
  const { POST } = await import("@/app/api/blog/route");
  const { NextRequest } = await import("next/server");
  const response = await quiet(() => POST(new NextRequest("http://localhost/api/blog", {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify({ title: "Post", content: "Body text", generateSeo: true }),
  })));
  const created = await response.json();
  assert.deepEqual(calls, [{ provider: "acp", model: PLATFORM_MODEL }], "blog uses the platform default");
  assert.equal(created.excerpt, "Short summary", "the generated metadata is used");
  assert.deepEqual(created.tags, ["ci", "bun"]);
  noAnthropic();
}

console.log("PASS answers run on the configured models");
