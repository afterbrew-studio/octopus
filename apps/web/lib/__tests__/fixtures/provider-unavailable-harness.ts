import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { providerUnavailableReason } from "@/lib/providers/unavailable";

/** The classifier against the error classes the provider SDKs really throw, and the router's wrapper around them. */

const headers = new Headers();
const openai = (status: number) => OpenAI.APIError.generate(status, { error: { message: "fixture" } }, "fixture", headers);
const anthropic = (status: number) => Anthropic.APIError.generate(status, { error: { type: "fixture", message: "fixture" } }, "fixture", headers);
// What ai-router throws: the provider error becomes the cause of a plain Error.
const routed = (cause: unknown) => new Error("AI provider opencode failed: fixture", { cause });
const socketError = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

for (const status of [402, 408, 429, 500, 502, 503, 529]) {
  assert.equal(providerUnavailableReason(openai(status)), String(status));
  assert.equal(providerUnavailableReason(anthropic(status)), String(status));
  assert.equal(providerUnavailableReason(routed(openai(status))), String(status));
}

for (const status of [400, 401, 403, 404, 409, 422]) {
  assert.equal(providerUnavailableReason(openai(status)), null, `${status} is the request or the credential`);
  assert.equal(providerUnavailableReason(routed(anthropic(status))), null);
}

assert.equal(providerUnavailableReason(new OpenAI.APIConnectionError({ message: undefined, cause: socketError("ECONNRESET") })), "connection");
assert.equal(providerUnavailableReason(routed(new OpenAI.APIConnectionError({ message: undefined, cause: socketError("UND_ERR_HEADERS_TIMEOUT") }))), "timeout");
assert.equal(providerUnavailableReason(new OpenAI.APIConnectionTimeoutError()), "timeout");
assert.equal(providerUnavailableReason(new OpenAI.APIConnectionError({ message: undefined, cause: undefined })), "connection");
assert.equal(providerUnavailableReason(new Anthropic.APIConnectionTimeoutError()), "timeout");
assert.equal(providerUnavailableReason(routed(socketError("ETIMEDOUT"))), "timeout");

const refused = Object.assign(new Error("bad request"), { status: 400, cause: socketError("ECONNRESET") });
assert.equal(providerUnavailableReason(refused), null, "a status settles the answer over anything beneath it");

assert.equal(providerUnavailableReason(new OpenAI.APIUserAbortError()), null);
assert.equal(providerUnavailableReason(new Error("gateway returned no text (finish_reason: stop)")), null);
assert.equal(providerUnavailableReason(new Error("429 mentioned only in prose")), null);
assert.equal(providerUnavailableReason("429"), null);
assert.equal(providerUnavailableReason(undefined), null);

console.log("PASS the classifier reads the status and connection errors the SDKs throw");
