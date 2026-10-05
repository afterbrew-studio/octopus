import { mock } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

mock.module("server-only", () => ({}));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ appId: "1", privateKey }) }));

const { createPullRequestReview, findReviewContaining } = await import("@/lib/github");
const { AmbiguousPublicationError } = await import("@/lib/review-publication");

/**
 * A review POST can fail after GitHub applied it. A caller that bounds the call
 * owns retry, so that failure must read as unknown, never as a rejection, and
 * must not be retried underneath it.
 */

type Script = (url: string, init: RequestInit) => Response | Promise<Response>;
const requests: string[] = [];
const routeFetch = (script: Script) => {
  requests.length = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push(`${init.method ?? "GET"} ${url}`);
    return script(url, init);
  }) as typeof fetch;
};
const post = (signal?: AbortSignal) => createPullRequestReview(1, "o", "r", 7, "body", "COMMENT", [], "token", "a".repeat(40), signal);
const reviewPosts = () => requests.filter((r) => r.startsWith("POST") && r.endsWith("/reviews")).length;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const quiet = console.warn;
console.warn = () => {};

routeFetch(() => { throw new TypeError("socket hang up"); });
await assert.rejects(post(AbortSignal.timeout(5000)), AmbiguousPublicationError);
assert.equal(reviewPosts(), 1);

routeFetch((_url, init) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
await assert.rejects(post(AbortSignal.timeout(30)), AmbiguousPublicationError, "a request that outlived its bound is unknown, not failed");

routeFetch(() => json({ message: "bad gateway" }, 502));
await assert.rejects(post(AbortSignal.timeout(5000)), AmbiguousPublicationError);
assert.equal(reviewPosts(), 1, "a bounded POST is not retried underneath its caller");

routeFetch(() => json({ message: "Unprocessable" }, 422));
await assert.rejects(post(AbortSignal.timeout(5000)), (error: Error) => !(error instanceof AmbiguousPublicationError) && /422/.test(error.message));

let attempt = 0;
routeFetch(() => (attempt++ < 2 ? json({}, 502) : json({ id: 99 })));
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void) => originalSetTimeout(fn, 0)) as typeof setTimeout;
assert.equal(await post(), 99, "an unbounded caller keeps the gateway-error retries");
globalThis.setTimeout = originalSetTimeout;
assert.equal(reviewPosts(), 3);

const marker = "<!-- octopus-attempt:abc -->";
const review = (id: number, body: string | null) => ({ id, body });
const pages: Record<string, unknown[]> = {
  "1": Array.from({ length: 100 }, (_, i) => review(i + 1, "other")),
  "2": [review(101, `${marker}\nreview`), review(102, null)],
};
routeFetch((url) => (url.includes("/access_tokens") ? json({ token: "t" }, 201) : json(pages[new URL(url).searchParams.get("page")!] ?? [])));
assert.equal(await findReviewContaining(1, "o", "r", 7, marker), 101, "found on a later page");
assert.equal(await findReviewContaining(1, "o", "r", 7, "<!-- octopus-attempt:none -->"), null);
routeFetch((url) => (url.includes("/access_tokens") ? json({ token: "t" }, 201) : json({}, 500)));
await assert.rejects(findReviewContaining(1, "o", "r", 7, marker), /500/, "an unreadable list is unknown, not empty");

console.warn = quiet;
console.log("PASS github review publication reports unknown outcomes and reconciles by marker");
