import assert from "node:assert/strict";
import { calls, usage, reply, reset, quiet, prisma, ORG_MODEL } from "./gateway-only";

/**
 * Side tasks run on OCTOPUS_UTILITY_MODEL, or the review model when it is unset, and the chat
 * guard refuses a message it could not classify.
 */

const UTILITY = "acp:MiniMax-M3";
const { getUtilityModel } = await import("@/lib/ai-client");
const { checkChatScope } = await import("@/lib/chat-guard");
const { generateChatTitle, translateToEnglish } = await import("@/lib/chat-side-tasks");

delete process.env.OCTOPUS_UTILITY_MODEL;
assert.equal(await getUtilityModel("org"), ORG_MODEL, "unset: the review model");

let lookups = 0;
const org = prisma.organization as { findUnique: () => Promise<unknown> };
const original = org.findUnique;
org.findUnique = async () => { lookups++; return original(); };
process.env.OCTOPUS_UTILITY_MODEL = `  ${UTILITY}  `;
assert.equal(await getUtilityModel("org"), UTILITY, "set: the trimmed utility model");
assert.equal(lookups, 0, "set: no organization lookup");
process.env.OCTOPUS_UTILITY_MODEL = "   ";
assert.equal(await getUtilityModel("org"), ORG_MODEL, "blank: the review model");
org.findUnique = original;

process.env.OCTOPUS_UTILITY_MODEL = UTILITY;

reset();
reply.text = "ALLOW";
assert.equal(await quiet(() => checkChatScope("why does CI fail?", "org")), "allow");
assert.deepEqual(calls, [{ provider: "acp", model: UTILITY }], "the guard runs on the utility model through its gateway");
assert.deepEqual(usage, [{ model: UTILITY, operation: "chat-guard", provider: "acp" }]);

reset();
reply.text = "BLOCK";
assert.equal(await quiet(() => checkChatScope("write my roleplay", "org")), "block");

reset();
reply.error = new Error("gateway down");
assert.equal(await quiet(() => checkChatScope("hello", "org")), "unavailable", "a provider error refuses the message");

reset();
reply.text = "I cannot decide";
assert.equal(await quiet(() => checkChatScope("hello", "org")), "unavailable", "an unparseable verdict refuses the message");

reset();
reply.text = "  Fixing the flaky CI  ";
assert.equal(await generateChatTitle("title this", "org", "New Chat"), "Fixing the flaky CI");
assert.deepEqual(calls, [{ provider: "acp", model: UTILITY }], "titles run on the utility model");
assert.deepEqual(usage, [{ model: UTILITY, operation: "chat-title", provider: "acp" }]);

reset();
reply.text = "How do I fix the build?";
assert.equal(await translateToEnglish("Как исправить сборку?", "org"), "How do I fix the build?");
assert.deepEqual(calls, [{ provider: "acp", model: UTILITY }], "translation runs on the utility model");
assert.deepEqual(usage, [{ model: UTILITY, operation: "chat-translate", provider: "acp" }]);

reset();
assert.equal(await translateToEnglish("How do I fix the build?", "org"), "How do I fix the build?");
assert.deepEqual(calls, [], "Latin text is not sent for translation");

reset();
reply.error = new Error("gateway down");
assert.equal(await quiet(() => translateToEnglish("Как исправить сборку?", "org")), "Как исправить сборку?", "a translation failure keeps the original text");

console.log("PASS side tasks run on the utility model");
