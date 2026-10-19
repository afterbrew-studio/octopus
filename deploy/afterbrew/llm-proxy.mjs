/**
 * MiniMax speaks the OpenAI wire protocol except for one field: it reasons
 * inline unless the request carries `thinking: {"type": "disabled"}`, and it
 * ignores `reasoning_effort`, which is the only reasoning control a generic
 * OpenAI-compatible client knows how to send. Left alone the model returns its
 * reasoning as a `<think>` block inside `message.content`; that message goes
 * back in history on the next turn and MiniMax rejects the request with
 * `400 invalid params (2013)`. An agent run therefore dies immediately after
 * its first tool call, while a one-shot with no tool call succeeds - which is
 * why a smoke test does not catch it.
 *
 * This forwards to MiniMax unchanged apart from adding that one field, so the
 * vendor stays reachable through the stock provider. It is deliberately not a
 * general-purpose proxy: it rewrites chat completions and pipes everything
 * else through untouched.
 */
import { createServer } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';

const PORT = Number(process.env.PROXY_PORT ?? 8080);
const UPSTREAM = new URL(process.env.UPSTREAM_BASE_URL ?? 'https://api.minimax.io');

/**
 * A second vendor behind the same port, chosen by the model the request names.
 *
 * The caller has ONE generic OpenAI-compatible provider slot and this proxy
 * occupies it, so a vendor that is not reachable through this port is not
 * reachable at all. Routing here keeps the slot shared instead of making the
 * cheap tier unreachable - the model id already names its vendor, so the
 * catalogue side needs nothing new.
 *
 * Unset leaves the proxy single-vendor, exactly as before.
 */
const DEEPSEEK = process.env.DEEPSEEK_BASE_URL ? new URL(process.env.DEEPSEEK_BASE_URL) : null;
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? '';

/** Which upstream serves this model, and the credential that upstream expects. */
function routeFor(model) {
  if (DEEPSEEK && typeof model === 'string' && model.toLowerCase().startsWith('deepseek')) {
    return { upstream: DEEPSEEK, key: DEEPSEEK_KEY, vendor: 'deepseek' };
  }
  return { upstream: UPSTREAM, key: null, vendor: 'minimax' };
}
/** Bodies above this are forwarded unread; a chat completion is far smaller. */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;

/**
 * A long turn ships a large prompt and then waits, silently, while the vendor
 * thinks. Nothing was holding that connection open: short requests always
 * succeeded while long ones died with `ETIMEDOUT` mid-wait, and the run lost
 * everything it had done - one gave up after 661k input tokens. TCP keep-alive
 * gives the path something to see, so an idle-but-live connection is not
 * mistaken for a dead one.
 */
const UPSTREAM_AGENT = new Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 64 });

/** Generous, but not unbounded: a turn that has produced nothing in this long is stuck. */
const UPSTREAM_TIMEOUT_MS = 10 * 60_000;

/**
 * Hop-by-hop headers belong to one connection and must not be relayed onto the
 * next one. Copying `transfer-encoding` in particular corrupts a streamed reply:
 * the upstream declares chunked framing, Node applies its own on top, and the
 * caller sees the response end mid-stream - `Premature close`. Short replies
 * survive it, which is why a smoke test passes and only long agent turns break.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function withoutHopByHop(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/**
 * The caller emits one assistant turn as TWO messages - the tool call with empty
 * content, then the prose - which leaves the `tool` result no longer adjacent
 * to the call it answers, and the call itself carrying `content: ""`.
 *
 * This is a defect in what WE send, not a vendor quirk, so it is repaired for
 * every vendor behind this port. Strict endpoints refuse it in their own words:
 * MiniMax with `400 invalid params (2013)`, DeepSeek with `400 An assistant
 * message with 'tool_calls' must be followed by tool messages`. OpenAI and Z.AI
 * happen to accept it, which is what made it look vendor-specific.
 *
 * Folding the prose back into the call-bearing message restores the adjacency
 * and gives it real content, losing nothing: it is one turn either way.
 */
function mergeSplitAssistantTurns(messages) {
  const out = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    const isTrailingProse =
      previous?.role === 'assistant' &&
      message?.role === 'assistant' &&
      Array.isArray(previous.tool_calls) &&
      !Array.isArray(message.tool_calls);
    if (isTrailingProse) {
      const text = [previous.content, message.content].map((part) => String(part ?? '').trim()).filter(Boolean);
      out[out.length - 1] = { ...previous, content: text.join('\n') };
      continue;
    }
    out.push(message);
  }
  return out;
}

/**
 * Repair the request body, and report the model so the caller can route on it
 * without parsing twice.
 *
 * The two repairs have different scopes on purpose: the split assistant turn is
 * a defect in what we send and is fixed for every vendor, while `thinking` is a
 * MiniMax quirk and is sent only there.
 */
/**
 * M3.1 refuses `thinking: disabled` (it requires adaptive thinking) and returns
 * its reasoning in `reasoning_content`, never inline, so it needs neither the
 * field nor the protection the field exists for.
 */
function requiresAdaptiveThinking(model) {
  return typeof model === 'string' && /^minimax-m3\.1/i.test(model);
}

function withThinkingDisabled(raw) {
  const body = JSON.parse(raw);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { payload: raw, model: null };
  const model = typeof body.model === 'string' ? body.model : null;
  const patched = { ...body };
  // Every vendor: the malformed turn is ours to fix wherever it is sent.
  if (Array.isArray(patched.messages)) patched.messages = mergeSplitAssistantTurns(patched.messages);
  // MiniMax only: `thinking` IS a vendor quirk, and asking another endpoint to
  // honour a field it never declared is a different mistake.
  if (routeFor(model).vendor === 'minimax' && !('thinking' in patched) && !requiresAdaptiveThinking(model)) {
    // `reasoning_effort` is what the caller sends and what MiniMax ignores. Dropping
    // it keeps the request honest about which control actually applies.
    delete patched.reasoning_effort;
    patched.thinking = { type: 'disabled' };
  }
  return { payload: JSON.stringify(patched), model };
}

const server = createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
  });

  req.on('end', () => {
    const original = Buffer.concat(chunks);
    let payload = original;
    let model = null;

    // Only chat completions carry the field, and only if the body parses. A
    // body we cannot read is forwarded as it arrived rather than rejected:
    // failing here would turn a vendor's new endpoint into an outage.
    if (!tooLarge && req.method === 'POST' && req.url.includes('/chat/completions') && original.length > 0) {
      try {
        const rewritten = withThinkingDisabled(original.toString('utf8'));
        payload = Buffer.from(rewritten.payload, 'utf8');
        model = rewritten.model;
      } catch {
        payload = original;
      }
    }

    const route = routeFor(model);
    const headers = { ...withoutHopByHop(req.headers), host: route.upstream.host };
    // The caller holds ONE credential for this port, so a second vendor behind it
    // must be given its own. Replaced rather than added: two auth headers is an
    // ambiguity each vendor resolves differently.
    if (route.key) headers.authorization = `Bearer ${route.key}`;
    delete headers['content-length'];
    if (payload.length > 0) headers['content-length'] = String(payload.length);

    const upstream = httpsRequest(
      {
        protocol: route.upstream.protocol,
        hostname: route.upstream.hostname,
        port: route.upstream.port || 443,
        path: req.url,
        method: req.method,
        headers,
        agent: UPSTREAM_AGENT,
        timeout: UPSTREAM_TIMEOUT_MS,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, withoutHopByHop(upstreamRes.headers));
        // Piped rather than buffered: completions stream, and holding the
        // response would defeat the streaming the caller asked for. An error
        // mid-stream destroys the caller's socket instead of ending it cleanly,
        // so a truncated answer is not mistaken for a complete one.
        upstreamRes.on('error', (err) => {
          console.log('upstream stream error', err.code ?? '', err.message ?? String(err));
          res.destroy(err);
        });
        upstreamRes.pipe(res);
      },
    );

    // A transport failure here ends the caller's turn, so it is logged with the
    // code that caused it: `502 minimax proxy:` with nothing after the colon is
    // otherwise indistinguishable from the vendor rejecting the request.
    // Keep-alive probes on the socket itself, not just the pool: the pool keeps
    // an IDLE socket warm between requests, while this is what holds a socket
    // open DURING one long wait.
    upstream.on('socket', (socket) => socket.setKeepAlive(true, 15_000));
    upstream.on('timeout', () => {
      console.log('upstream timeout', req.method, req.url, `after ${UPSTREAM_TIMEOUT_MS}ms`);
      upstream.destroy(new Error(`upstream produced nothing for ${UPSTREAM_TIMEOUT_MS}ms`));
    });

    upstream.on('error', (err) => {
      console.log('upstream error', req.method, req.url, err.code ?? '', err.message ?? String(err));
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `minimax proxy: ${err.code ?? ''} ${err.message ?? ''}`.trim() } }));
    });

    if (payload.length > 0) upstream.write(payload);
    upstream.end();
  });

  req.on('error', () => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`minimax proxy listening on ${PORT} -> ${UPSTREAM.origin}`);
});
