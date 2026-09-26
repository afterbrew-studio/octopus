import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { prisma, type Prisma } from "@octopus/db";
import { validateForgejoOperation, validateForgejoResult, FORGEJO_MAX_RESPONSE_BYTES } from "@octopus/forgejo-connector/protocol";
import { isPostgresSafeText, readBoundedJson } from "@/lib/bounded-json";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { ForgejoHttpError, ForgejoResponseTooLargeError, type forgejoRequest } from "@/lib/forgejo-http";

const REQUEST_TTL_MS = 60_000;
const LEASE_MS = 20_000;
const RETENTION_MS = 5 * 60_000;
export const FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE = "A Forgejo write has an unknown result. Check Forgejo before reconnecting.";

export class ForgejoConnectorUncertainError extends Error {
  constructor() { super(FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE); }
}

export function createConnectorToken(): string { return `ofc_${randomBytes(32).toString("hex")}`; }
export function hashConnectorToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }

type Tx = Prisma.TransactionClient;
type Operation = { path: string; method: "GET" | "POST" | "PATCH"; body?: unknown; maxBytes: number };
type Result = { result: { body: string; headers: { "x-hasmore"?: string } } } | { error: "http" | "too_large" | "failed"; status?: number };
type Auth = { id: string; tokenHash: string };

type PublicationOptions = {
  key: string;
  signal?: AbortSignal;
  acknowledged: (tx: Tx) => Promise<boolean>;
};
type Publication = {
  options: PublicationOptions;
  auth?: Auth;
  markerId?: string;
  token: string;
  requests: Set<string>;
  deadline: number;
  failed: boolean;
};
const publications = new AsyncLocalStorage<Publication>();

async function pausePublication(tx: Tx, scope: Publication): Promise<void> {
  scope.failed = true;
  if (!scope.auth || !scope.markerId || !await lockIntegration(tx, scope.auth)) return;
  const marker = await tx.forgejoConnectorRequest.findFirst({ where: {
    id: scope.markerId, integrationId: scope.auth.id, leaseToken: scope.token,
  } });
  if (!marker) return;
  await tx.forgejoIntegration.updateMany({ where: { id: scope.auth.id }, data: { connectorError: FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE } });
  await tx.forgejoConnectorRequest.updateMany({ where: {
    integrationId: scope.auth.id, id: { in: [scope.markerId, ...scope.requests] },
  }, data: { status: "uncertain", requestEnc: "", responseEnc: null, expiresAt: new Date() } });
}

async function validPublication(tx: Tx, scope: Publication, final: boolean): Promise<boolean> {
  if (scope.failed || scope.options.signal?.aborted || Date.now() >= scope.deadline || !scope.auth || !scope.markerId) return false;
  const rows = await tx.forgejoConnectorRequest.findMany({ where: {
    integrationId: scope.auth.id, id: { in: [scope.markerId, ...scope.requests] },
  } });
  const now = new Date();
  return rows.length === scope.requests.size + 1 && rows.every(row => row.expiresAt > now
    && (row.status !== "leased" || (!!row.leaseExpiresAt && row.leaseExpiresAt > now)) && (
    row.id === scope.markerId ? row.status === "publishing" && row.leaseToken === scope.token
      : final ? row.status === "delivered" : ["queued", "leased", "completed", "delivered"].includes(row.status)
  ));
}

async function settlePublication(scope: Publication, final: boolean): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const integration = await lockIntegration(tx, scope.auth!);
    if (!integration || integration.connectorError || !await validPublication(tx, scope, final)
      || (final && !await scope.options.acknowledged(tx))) {
      await pausePublication(tx, scope);
      return false;
    }
    const where = { integrationId: scope.auth!.id, id: { in: [scope.markerId!, ...scope.requests] } };
    if (final) {
      const removed = await tx.forgejoConnectorRequest.deleteMany({ where });
      if (removed.count !== scope.requests.size + 1) throw new ForgejoConnectorUncertainError();
    } else {
      const pending = await tx.forgejoConnectorRequest.count({ where: { ...where, status: { in: ["queued", "leased", "completed"] } } });
      const renewed = await tx.forgejoConnectorRequest.updateMany({ where: { ...where, status: { in: ["publishing", "delivered"] } },
        data: { expiresAt: new Date(Math.min(Date.now() + REQUEST_TTL_MS, scope.deadline)) } });
      if (renewed.count !== scope.requests.size + 1 - pending) {
        await pausePublication(tx, scope);
        return false;
      }
    }
    return true;
  });
}

async function failPublication(scope: Publication): Promise<void> {
  scope.failed = true;
  if (!scope.auth) return;
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM forgejo_integrations WHERE id = ${scope.auth!.id} FOR UPDATE`;
    await pausePublication(tx, scope);
  });
}

export async function withForgejoPublication<T>(publish: () => Promise<T>, options: PublicationOptions): Promise<T> {
  const parent = publications.getStore();
  if (parent) {
    try {
      if (parent.failed || parent.options.key !== options.key) throw new ForgejoConnectorUncertainError();
      const result = await publish();
      if (parent.failed || parent.options.signal?.aborted
        || (parent.markerId && !await options.acknowledged(prisma))) throw new ForgejoConnectorUncertainError();
      return result;
    } catch (error) {
      await failPublication(parent);
      throw error;
    }
  }
  const scope: Publication = { options, requests: new Set(), token: randomBytes(32).toString("hex"),
    deadline: Date.now() + 2 * 60 * 60_000, failed: false };
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    if (!scope.markerId || scope.failed) return;
    renewal = renewal.then(async () => {
      try {
        if (!await settlePublication(scope, false)) scope.failed = true;
      } catch {
        scope.failed = true;
        await failPublication(scope).catch(() => { scope.failed = true; });
      }
    });
  }, 10_000);
  timer.unref();
  try {
    const result = await publications.run(scope, publish);
    clearInterval(timer);
    await renewal;
    if (scope.failed || (scope.markerId && !await settlePublication(scope, true))) throw new ForgejoConnectorUncertainError();
    return result;
  } catch (error) {
    clearInterval(timer);
    await renewal;
    await failPublication(scope);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

async function authenticate(request: Request): Promise<Auth | null> {
  const token = request.headers.get("authorization")?.match(/^Bearer (ofc_[a-f0-9]{64})$/)?.[1];
  if (!token) return null;
  const tokenHash = hashConnectorToken(token);
  const integration = await prisma.forgejoIntegration.findUnique({ where: { connectorTokenHash: tokenHash }, select: { id: true } });
  return integration ? { id: integration.id, tokenHash } : null;
}

async function lockIntegration(tx: Tx, auth: Auth) {
  await tx.$queryRaw`SELECT id FROM forgejo_integrations WHERE id = ${auth.id} FOR UPDATE`;
  return tx.forgejoIntegration.findFirst({ where: {
    id: auth.id, connectorTokenHash: auth.tokenHash,
    organization: { bannedAt: null, deletedAt: null },
  } });
}

/** A missing write response cannot establish whether Forgejo committed it.
 * Hold the connection until an administrator reconciles that uncertainty. */
async function reap(tx: Tx, integrationId: string, now: Date): Promise<boolean> {
  const uncertain = await tx.forgejoConnectorRequest.updateMany({ where: {
    integrationId, method: { not: "GET" },
    OR: [
      { status: "leased", OR: [{ leaseExpiresAt: { lte: now } }, { expiresAt: { lte: now } }] },
      { status: { in: ["completed", "delivered", "publishing"] }, expiresAt: { lte: now } },
    ],
  }, data: { status: "uncertain", requestEnc: "", responseEnc: null } });
  if (uncertain.count) await tx.forgejoIntegration.update({ where: { id: integrationId }, data: { connectorError: FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE } });
  await tx.forgejoConnectorRequest.updateMany({ where: {
    integrationId, method: "GET", status: "leased", leaseExpiresAt: { lte: now }, expiresAt: { gt: now },
  }, data: { status: "queued", leaseToken: null, leaseExpiresAt: null } });
  await tx.forgejoConnectorRequest.deleteMany({ where: { integrationId, OR: [
    { expiresAt: { lte: now }, status: { in: ["queued", "completed"] } },
    { expiresAt: { lte: now }, method: "GET" },
    { status: { notIn: ["delivered", "publishing"] }, createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  ] } });
  return uncertain.count > 0;
}

export async function cleanupForgejoConnectorRequests(): Promise<void> {
  const now = new Date();
  const integrations = await prisma.forgejoConnectorRequest.findMany({ where: {
    OR: [{ expiresAt: { lte: now } }, { status: "leased", leaseExpiresAt: { lte: now } }],
  }, distinct: ["integrationId"], select: { integrationId: true }, take: 100 });
  for (const { integrationId } of integrations) await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM forgejo_integrations WHERE id = ${integrationId} FOR UPDATE`;
    if (await tx.forgejoIntegration.findUnique({ where: { id: integrationId }, select: { id: true } })) await reap(tx, integrationId, now);
  });
}

function reply(error: string, status: number) { return Response.json({ error }, { status }); }
const unauthorized = () => reply("Connector authorization failed", 401);
const invalid = () => reply("Invalid connector request", 400);

export async function pollForgejoConnector(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return unauthorized();
  const parsed = await readBoundedJson(request, 4096);
  if (!parsed.ok) return reply("Invalid connector request", parsed.reason === "too_large" ? 413 : 400);
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
  const { host, username, capacity = 4 } = body as Record<string, unknown>;
  if (typeof host !== "string" || host.length > 2048 || typeof username !== "string"
    || !username.trim() || username.length > 255 || !isPostgresSafeText(username) || /[\x00-\x20\x7f]/.test(username)
    || !Number.isInteger(capacity) || (capacity as number) < 0 || (capacity as number) > 4
    || Object.keys(body).some(key => !["host", "username", "capacity"].includes(key))) return invalid();
  return prisma.$transaction(async tx => {
    const integration = await lockIntegration(tx, auth);
    if (!integration) return unauthorized();
    const now = new Date();
    const uncertain = await reap(tx, integration.id, now);
    if (host !== integration.forgejoHost || (integration.username && username !== integration.username)) return reply("Connector identity does not match this integration", 409);
    await tx.forgejoIntegration.update({ where: { id: integration.id }, data: { username, connectorLastSeenAt: now } });
    if (integration.connectorError || uncertain) return reply(FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE, 409);
    const active = await tx.forgejoConnectorRequest.count({ where: { integrationId: integration.id, status: "leased" } });
    const pending = await tx.forgejoConnectorRequest.findMany({ where: {
      integrationId: integration.id, status: "queued", expiresAt: { gt: now },
    }, orderBy: { createdAt: "asc" }, take: Math.min(capacity as number, Math.max(0, 4 - active)) });
    const commands = [];
    for (const task of pending) {
      const operation = decryptJson<Operation>(task.requestEnc);
      validateForgejoOperation(operation);
      const leaseToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Math.min(now.getTime() + LEASE_MS, task.expiresAt.getTime()));
      await tx.forgejoConnectorRequest.update({ where: { id: task.id }, data: { status: "leased", leaseToken, leaseExpiresAt: expiresAt } });
      commands.push({ id: task.id, leaseToken, ...operation, expiresAt: expiresAt.toISOString() });
    }
    return Response.json({ integrationId: integration.id, commands }, { headers: { "Cache-Control": "no-store" } });
  });
}

function uncertainWrite(method: string, result: Result): boolean {
  if (method === "GET") return false;
  if ("error" in result) return result.error !== "http" || (result.status ?? 500) >= 500;
  if (method === "POST") {
    // Every allowed POST creates a Forgejo object. Without its ID the caller
    // cannot safely record or reconcile that publication.
    try { const value = JSON.parse(result.result.body); return !Number.isSafeInteger(value?.id) || value.id <= 0; }
    catch { return true; }
  }
  return false;
}

export async function completeForgejoConnector(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth) return unauthorized();
  // JSON may escape one byte of response text into six bytes on the wire.
  const parsed = await readBoundedJson(request, FORGEJO_MAX_RESPONSE_BYTES * 6 + 2048);
  if (!parsed.ok) return reply("Invalid connector result", parsed.reason === "too_large" ? 413 : 400);
  let body: ReturnType<typeof validateForgejoResult>;
  try { body = validateForgejoResult(parsed.value); } catch { return invalid(); }
  const result: Result = "result" in body ? { result: body.result } : body.error === "http" ? { error: body.error, status: body.status } : { error: body.error };
  return prisma.$transaction(async tx => {
    const integration = await lockIntegration(tx, auth);
    if (!integration) return unauthorized();
    const now = new Date();
    await reap(tx, integration.id, now);
    const task = await tx.forgejoConnectorRequest.findFirst({ where: { id: body.id, integrationId: integration.id, leaseToken: body.leaseToken } });
    if (!task) return reply("Connector command is no longer available", 404);
    if (task.status === "delivered") {
      return task.responseEnc === createHash("sha256").update(JSON.stringify(result)).digest("hex")
        ? Response.json({ ok: true }) : reply("Connector result conflicts with the recorded result", 409);
    }
    if (task.status === "completed") {
      if (!task.responseEnc || JSON.stringify(decryptJson<Result>(task.responseEnc)) !== JSON.stringify(result)) return reply("Connector result conflicts with the recorded result", 409);
      return Response.json({ ok: true });
    }
    if (task.status !== "leased" || !task.leaseExpiresAt || task.leaseExpiresAt <= now || task.expiresAt <= now) return reply("Connector command has expired", 409);
    const operation = decryptJson<Operation>(task.requestEnc);
    if ("result" in result && Buffer.byteLength(result.result.body, "utf8") > operation.maxBytes) return reply("Connector response exceeds the command budget", 413);
    if (uncertainWrite(task.method, result)) await tx.forgejoIntegration.update({ where: { id: integration.id }, data: { connectorError: FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE } });
    await tx.forgejoConnectorRequest.update({ where: { id: task.id }, data: { status: "completed", responseEnc: encryptJson(result), requestEnc: "" } });
    return Response.json({ ok: true });
  });
}

async function cancel(auth: Auth, id: string): Promise<boolean> {
  return prisma.$transaction(async tx => {
    const integration = await lockIntegration(tx, auth);
    if (!integration) return false;
    const task = await tx.forgejoConnectorRequest.findFirst({ where: { id, integrationId: auth.id } });
    if (!task) return false;
    if (task.method !== "GET" && ["leased", "completed", "delivered"].includes(task.status)) {
      await tx.forgejoIntegration.update({ where: { id: auth.id }, data: { connectorError: FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE } });
      await tx.forgejoConnectorRequest.update({ where: { id }, data: { status: "uncertain", requestEnc: "", responseEnc: null } });
      return true;
    } else await tx.forgejoConnectorRequest.delete({ where: { id } });
    return false;
  });
}

export async function requestViaForgejoConnector(
  integrationId: string,
  connectorTokenHash: string,
  path: string,
  options: Parameters<typeof forgejoRequest>[3] = {},
): ReturnType<typeof forgejoRequest> {
  const operation: Operation = { path, method: options.method ?? "GET", maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    ...(options.body === undefined ? {} : { body: options.body }) };
  validateForgejoOperation(operation);
  options.signal?.throwIfAborted();
  const auth = { id: integrationId, tokenHash: connectorTokenHash };
  const scope = publications.getStore();
  if (scope?.failed) throw new ForgejoConnectorUncertainError();
  const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
  const task = await prisma.$transaction(async tx => {
    const integration = await lockIntegration(tx, auth);
    if (!integration) throw new Error("Forgejo connector is no longer connected");
    const uncertain = await reap(tx, integration.id, new Date());
    if (integration.connectorError || uncertain) return null;
    if (!integration.username || !integration.connectorLastSeenAt || Date.now() - integration.connectorLastSeenAt.getTime() > 90_000) throw new Error("Forgejo connector is offline. Start the connector and retry.");
    const count = await tx.forgejoConnectorRequest.count({ where: { integrationId, status: { in: ["queued", "leased"] } } });
    if (count >= 64) throw new Error("Forgejo connector is busy. Retry after current requests finish.");
    if (scope) {
      if (scope.failed || scope.options.signal?.aborted || Date.now() >= scope.deadline
        || (scope.auth && (scope.auth.id !== auth.id || scope.auth.tokenHash !== auth.tokenHash))) {
        await pausePublication(tx, scope);
        return null;
      }
      if (scope.markerId) {
        if (!await validPublication(tx, scope, false)) {
          await pausePublication(tx, scope);
          return null;
        }
      } else if (operation.method !== "GET") {
        scope.auth = auth;
        scope.markerId = `publication_${createHash("sha256").update(JSON.stringify([integrationId, scope.options.key])).digest("hex")}`;
        if (await tx.forgejoConnectorRequest.findUnique({ where: { id: scope.markerId } })) {
          await tx.forgejoIntegration.update({ where: { id: integrationId }, data: { connectorError: FORGEJO_CONNECTOR_UNCERTAIN_MESSAGE } });
          await tx.forgejoConnectorRequest.update({ where: { id: scope.markerId },
            data: { status: "uncertain", requestEnc: "", responseEnc: null, expiresAt: new Date() } });
          return null;
        }
        await tx.forgejoConnectorRequest.create({ data: {
          id: scope.markerId, integrationId, method: "POST", status: "publishing", requestEnc: "",
          leaseToken: scope.token, expiresAt: new Date(Math.min(Date.now() + REQUEST_TTL_MS, scope.deadline)),
        } });
      }
    }
    const request = await tx.forgejoConnectorRequest.create({ data: { integrationId, method: operation.method, requestEnc: encryptJson(operation), expiresAt } });
    if (operation.method !== "GET") scope?.requests.add(request.id);
    return request;
  });
  if (!task) {
    if (scope) scope.failed = true;
    throw new ForgejoConnectorUncertainError();
  }
  try {
    while (Date.now() < expiresAt.getTime()) {
      options.signal?.throwIfAborted();
      const state = await prisma.$transaction(async tx => {
        const integration = await lockIntegration(tx, auth);
        if (!integration) return { disconnected: true };
        const uncertain = await reap(tx, integration.id, new Date());
        if (scope?.markerId && (integration.connectorError || uncertain || !await validPublication(tx, scope, false))) {
          await pausePublication(tx, scope);
          return { uncertain: true };
        }
        const current = await tx.forgejoConnectorRequest.findFirst({ where: { id: task.id, integrationId } });
        if (current?.status === "completed" && current.responseEnc) {
          const result = decryptJson<Result>(current.responseEnc);
          const uncertain = uncertainWrite(current.method, result);
          if (current.method !== "GET" && "result" in result && !uncertain) {
            await tx.forgejoConnectorRequest.update({ where: { id: current.id }, data: {
              status: "delivered", responseEnc: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
              expiresAt: new Date(Math.min(Date.now() + REQUEST_TTL_MS, scope?.deadline ?? Infinity)),
            } });
          } else if (!uncertain) {
            await tx.forgejoConnectorRequest.delete({ where: { id: current.id } });
            scope?.requests.delete(current.id);
          }
          return { result, uncertain };
        }
        return { uncertain: Boolean(uncertain || integration.connectorError || current?.status === "uncertain"), missing: !current };
      });
      if (state.uncertain) throw new ForgejoConnectorUncertainError();
      if (state.disconnected || state.missing) throw new Error("Forgejo connector request is no longer available");
      if (state.result) {
        if ("result" in state.result) return state.result.result;
        if (state.result.error === "http") throw new ForgejoHttpError(state.result.status ?? 502);
        if (state.result.error === "too_large") throw new ForgejoResponseTooLargeError();
        throw new Error("Forgejo connector could not complete the request");
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Forgejo connector request timed out");
  } catch (error) {
    if (await cancel(auth, task.id)) throw new ForgejoConnectorUncertainError();
    throw error;
  }
}
