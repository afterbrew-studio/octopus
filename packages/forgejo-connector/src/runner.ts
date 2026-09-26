import { request } from "node:https";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { forgejoRequest, ForgejoHttpError, ForgejoResponseTooLargeError, normalizeForgejoHost } from "./http";
import {
  FORGEJO_MAX_REQUEST_BYTES, validateForgejoCommand, validateForgejoResult,
  type ForgejoCommand, type ForgejoResult,
} from "./protocol";

class CloudHttpError extends Error {
  constructor(readonly status: number) { super(`Octopus request failed (${status})`); }
}

function configuration(env: NodeJS.ProcessEnv) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS verification must remain enabled");
  if (!env.OCTOPUS_URL || !env.FORGEJO_URL) throw new Error("Set OCTOPUS_URL and FORGEJO_URL to HTTPS origins");
  const cloud = normalizeForgejoHost(env.OCTOPUS_URL, { allowPrivate: true });
  const host = normalizeForgejoHost(env.FORGEJO_URL, { allowPrivate: true });
  const token = env.OCTOPUS_CONNECTOR_TOKEN;
  if (!token || !/^ofc_[a-f0-9]{64}$/.test(token)) throw new Error("Set a valid OCTOPUS_CONNECTOR_TOKEN");
  const forgejoToken = env.FORGEJO_TOKEN;
  if (!forgejoToken || forgejoToken.length > 4096 || /[\r\n]/.test(forgejoToken)) throw new Error("Set FORGEJO_TOKEN to the local Forgejo access token");
  return { cloud, host, token, forgejoToken };
}

/** Fixed operator-selected origin and paths; redirects and proxy settings are
 * never followed. Only the connector credential is attached to Cloud calls. */
async function cloudRequest(config: ReturnType<typeof configuration>, endpoint: "poll" | "result",
  serialized: string, signal?: AbortSignal): Promise<unknown> {
  const maxBytes = endpoint === "poll" ? 4 * FORGEJO_MAX_REQUEST_BYTES + 16 * 1024 : 16 * 1024;
  return new Promise((resolve, reject) => {
    const req = request(`${config.cloud}/api/forgejo/connector/${endpoint}`, {
      method: "POST", agent: false, rejectUnauthorized: true,
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(serialized), "Accept-Encoding": "identity" },
    }, response => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.destroy(); reject(new CloudHttpError(status)); return;
      }
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.destroy(); reject(new Error("Unsupported Octopus response encoding")); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          response.destroy(); reject(new Error("Octopus response exceeds connector limits")); return;
        }
        chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("Octopus response interrupted")));
      response.on("end", () => {
        try { resolve(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); }
        catch { reject(new Error("Invalid Octopus response")); }
      });
    });
    req.on("error", () => reject(new Error("Octopus connection failed or timed out")));
    req.end(serialized);
  });
}

async function execute(config: ReturnType<typeof configuration>, command: ForgejoCommand): Promise<ForgejoResult> {
  const binding = { id: command.id, leaseToken: command.leaseToken };
  const remaining = Date.parse(command.expiresAt) - Date.now();
  if (remaining <= 0) return { ...binding, error: "failed" };
  try {
    const response = await forgejoRequest(config.host, config.forgejoToken, command.path, {
      method: command.method, body: command.body, maxBytes: command.maxBytes, allowPrivate: true,
      signal: AbortSignal.timeout(remaining),
    });
    const more = response.headers["x-hasmore"];
    return validateForgejoResult({ ...binding, result: { body: response.body,
      headers: more === "true" || more === "false" ? { "x-hasmore": more } : {} } });
  } catch (error) {
    if (error instanceof ForgejoHttpError && error.status >= 100 && error.status <= 599) {
      return { ...binding, error: "http", status: error.status };
    }
    return { ...binding, error: error instanceof ForgejoResponseTooLargeError ? "too_large" : "failed" };
  }
}

async function complete(config: ReturnType<typeof configuration>, command: ForgejoCommand): Promise<void> {
  // Keep the exact result until acknowledged. A lost acknowledgement never
  // repeats a Forgejo write. After a process crash Cloud marks leased writes as
  // uncertain; only read requests can be leased again.
  const result = JSON.stringify(await execute(config, command));
  const expiresAt = Date.parse(command.expiresAt);
  while (Date.now() < expiresAt) {
    try {
      await cloudRequest(config, "result", result, AbortSignal.timeout(expiresAt - Date.now()));
      return;
    } catch (error) {
      if (error instanceof CloudHttpError) {
        if ([400, 404, 409, 413].includes(error.status)) return;
        if (error.status === 401 || error.status === 403) throw error;
      }
      await delay(Math.min(1000, Math.max(0, expiresAt - Date.now())));
    }
  }
  console.warn("A command expired before Cloud acknowledged its result; check its review status before retrying.");
}

export const connectorPollDelay = (previous: number, busy: boolean): number => busy ? 50 : Math.min(1000, previous * 2);

export async function runConnector(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = configuration(env);
  const pollController = new AbortController();
  let stopped = false;
  let fatal: Error | undefined;
  const stop = () => { stopped = true; pollController.abort(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const active = new Map<string, Promise<void>>();
  // Bound duplicate suppression without retaining code or completed responses.
  const seen = new Map<string, number>();
  let integrationId: string | undefined;
  let username: string | undefined;
  let previouslyConnected = false;
  let connectionWarning = false;
  let pollDelay = 1000;
  try {
    while (!stopped) {
      try {
        if (!username) {
          const response = await forgejoRequest(config.host, config.forgejoToken, "/api/v1/user", {
            allowPrivate: true, maxBytes: 64 * 1024, signal: pollController.signal,
          });
          const user: unknown = JSON.parse(response.body);
          const login = user && typeof user === "object" && "login" in user ? user.login : undefined;
          if (typeof login !== "string" || !login || login.length > 255 || /[\x00-\x1f\x7f]/.test(login)) {
            throw new Error("Forgejo did not return an authenticated username");
          }
          username = login;
        }
        const reply = await cloudRequest(config, "poll", JSON.stringify({ host: config.host, username, capacity: 4 - active.size }), pollController.signal);
        if (!reply || typeof reply !== "object" || !("integrationId" in reply) || !("commands" in reply)
          || typeof reply.integrationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.integrationId)
          || !Array.isArray(reply.commands) || reply.commands.length > 4 - active.size) {
          throw new Error("Invalid Octopus connector poll response");
        }
        if (integrationId && integrationId !== reply.integrationId) throw new Error("Octopus connector binding changed");
        integrationId = reply.integrationId;
        // Validate the whole batch before executing any command.
        const commands = reply.commands.map(validateForgejoCommand);
        const now = Date.now();
        if (commands.some(command => Date.parse(command.expiresAt) - now > 120_000)) {
          throw new Error("Octopus command lease exceeds connector limits");
        }
        for (const [id, expiry] of seen) if (expiry <= now) seen.delete(id);
        for (const command of commands) {
          const expiry = Date.parse(command.expiresAt);
          if (expiry <= now || seen.has(command.id)) continue;
          seen.set(command.id, expiry);
          const job = complete(config, command).catch(error => {
            if (error instanceof CloudHttpError && [401, 403].includes(error.status)) { fatal = error; stop(); }
            else console.warn("A connector command failed; check its review status before retrying.");
          }).finally(() => { active.delete(command.id); });
          active.set(command.id, job);
        }
        if (!previouslyConnected) console.info("Forgejo connector connected. API access is ready; configure Forgejo webhooks in Octopus settings.");
        previouslyConnected = true;
        connectionWarning = false;
        pollDelay = connectorPollDelay(pollDelay, commands.length > 0 || active.size > 0);
      } catch (error) {
        if (stopped) break;
        if (error instanceof CloudHttpError && [400, 401, 403].includes(error.status)) {
          fatal = new Error("Connector rejected by Octopus. Check its token, Forgejo URL and account in integration settings."); stop(); break;
        }
        if (!connectionWarning) {
          console.warn(previouslyConnected ? "Connector connection interrupted; retrying."
            : "Waiting for Forgejo and Octopus HTTPS access. Check URLs, token permissions and trusted certificates.");
          connectionWarning = true;
        }
        previouslyConnected = false;
        pollDelay = 1000;
      }
      if (!stopped) await delay(pollDelay, undefined, { signal: pollController.signal }).catch(() => {});
    }
  } finally {
    stop();
    await Promise.allSettled(active.values());
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
  if (fatal) throw fatal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runConnector().catch(error => {
    // Errors constructed here never include credentials or Forgejo responses.
    console.error(error instanceof Error ? error.message : "Forgejo connector stopped");
    process.exitCode = 1;
  });
}
