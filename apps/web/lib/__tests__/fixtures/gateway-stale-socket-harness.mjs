import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";

// Read once at import: short, so a timeout scenario ends quickly.
process.env.GATEWAY_TIMEOUT_MS = "600";

/**
 * The gateway against a real HTTP server, through the real SDK and the real undici
 * dispatcher, run on Node as production is (`node apps/web/server.js`): Bun's own
 * fetch silently retries a closed pooled connection and honours no dispatcher, so
 * it would hide the fault. The gateway is bundled for Node by the test that runs this.
 */

const ok = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { content: "answer" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
};
const reset = (req) => { req.socket.destroy(); };
const hang = () => {};
const unavailable = (_req, res) => { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "overloaded" } })); };
const droppedMidBody = (_req, res) => {
  res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
  res.write('{"model":"m","choices":[');
  setTimeout(() => res.socket?.destroy(), 20);
};

let plan = [];
let requests = 0;
const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => (plan[requests++] ?? ok)(req, res));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;

const { callOpenAiGateway } = await import(pathToFileURL(process.argv[2]).href);

const call = () => callOpenAiGateway(
  { model: "opencode:glm-5.3", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
  { name: "opencode", modelPrefix: "opencode:", apiBase: base, apiKey: "k" },
);
const run = async (behaviours) => {
  plan = behaviours; requests = 0;
  const started = Date.now();
  const outcome = await call().then((value) => ({ value }), (error) => ({ error }));
  return { outcome, requests, ms: Date.now() - started };
};
const logged = [];
const originalError = console.error;
console.error = (...args) => { logged.push(args.map(String).join(" ")); };

// A pooled connection the provider has since closed: the call that reuses it is reset
// before any response and must succeed on a fresh one.
const first = await run([ok]);
assert.ok("value" in first.outcome && first.outcome.value.text === "answer");
const reused = await run([reset, ok]);
assert.ok("value" in reused.outcome, `a reset before any response must be retried: ${"error" in reused.outcome ? reused.outcome.error.message : ""}`);
assert.equal(reused.outcome.value.text, "answer");
assert.equal(reused.requests, 2, "retried once, on a fresh connection");

// The retry count is bounded: one try plus two retries, then the failure stands.
logged.length = 0;
const bounded = await run([reset, reset, reset, ok]);
assert.ok("error" in bounded.outcome, "a connection that keeps dying fails");
assert.equal(bounded.requests, 3, "no more than two retries");
assert.match(logged.join("\n"), /attempt 3\/3/);
assert.match(logged.join("\n"), /responseStarted=false/);
assert.match(logged.join("\n"), /"code":"(?:UND_ERR_SOCKET|ECONNRESET)"/, "the log carries the underlying cause, not just 'Connection error.'");
assert.match(logged.join("\n"), /\d+ms/);

// A timeout is not retried: the provider may be mid-generation, and repeating would double the wait.
const slow = await run([hang, ok]);
assert.ok("error" in slow.outcome);
assert.equal(slow.requests, 1, "a timeout is never retried");
assert.ok(slow.ms < 1500, `a timeout must end at its ceiling, not after a repeat (${slow.ms}ms)`);

// An HTTP status is the provider's answer, not a dead connection.
const overloaded = await run([unavailable, ok]);
assert.ok("error" in overloaded.outcome);
assert.equal(overloaded.outcome.error.status, 503);
assert.equal(overloaded.requests, 1, "a 5xx is not retried by this path");

// A response that began is never repeated.
const dropped = await run([droppedMidBody, ok]);
assert.ok("error" in dropped.outcome);
assert.equal(dropped.requests, 1, "a response that started is not retried");

console.error = originalError;
server.closeAllConnections();
server.close();
console.log("PASS gateway retries only a dead connection, before any response");
process.exit(0);
