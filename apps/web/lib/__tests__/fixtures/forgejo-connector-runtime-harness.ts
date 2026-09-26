import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request } from "node:http";
import { resolve } from "node:path";
import { prisma } from "@octopus/db";
import { mock } from "bun:test";

mock.module("server-only", () => ({}));
const { createConnectorToken, hashConnectorToken } = await import("@/lib/forgejo-connector");
const { encryptJson, decryptJson } = await import("@/lib/crypto");
const web = resolve(import.meta.dir, "../../..");
const fixture = resolve(web, ".next/forgejo-runtime-fixture");
const api = resolve(fixture, "app/api/forgejo/connector");
await mkdir(`${api}/poll`, { recursive: true });
await mkdir(`${api}/result`, { recursive: true });
for (const route of ["poll", "result"]) {
  await writeFile(`${api}/${route}/route.ts`, await readFile(`${web}/app/api/forgejo/connector/${route}/route.ts`));
}
await writeFile(`${fixture}/middleware.ts`, await readFile(`${web}/middleware.ts`));
await writeFile(`${fixture}/package.json`, JSON.stringify({ name: "forgejo-runtime-fixture", private: true }));
await writeFile(`${fixture}/next.config.mjs`, "export default {};\n");
await writeFile(`${fixture}/tsconfig.json`, JSON.stringify({
  extends: `${web}/tsconfig.json`, compilerOptions: { baseUrl: web, paths: { "@/*": ["./*"] }, incremental: false },
  include: ["next-env.d.ts", "app/**/*.ts", "middleware.ts", ".next/types/**/*.ts"], exclude: ["node_modules"],
}));
const env = { ...process.env, NEXT_TELEMETRY_DISABLED: "1", NEXT_PUBLIC_OCTOPUS_SELF_HOSTED: "false" };
const next = `${web}/node_modules/next/dist/bin/next`;
const build = Bun.spawn(["node", next, "build", "--webpack"], { cwd: fixture, env, stdout: "pipe", stderr: "pipe" });
const [buildCode, buildOut, buildErr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
assert.equal(buildCode, 0, buildOut + buildErr);
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const server = Bun.spawn(["node", next, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: fixture, env, stdout: "pipe", stderr: "pipe",
});
const logs = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]);
let organizationId: string | undefined;
try {
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(origin); ready = true; break; } catch { await Bun.sleep(100); }
  }
  assert.ok(ready, "Next server started");
  const token = createConnectorToken();
  const org = await prisma.organization.create({ data: { name: "Connector runtime", slug: `connector-runtime-${randomUUID()}` } });
  organizationId = org.id;
  const host = "https://forgejo.private.example";
  const integration = await prisma.forgejoIntegration.create({ data: {
    organizationId, forgejoHost: host, username: "bot", webhookSecret: randomUUID(), connectorTokenHash: hashConnectorToken(token),
  } });
  const post = (endpoint: string, body: unknown, authorized = true): Promise<Response> => new Promise((resolve, reject) => {
    const serialized = JSON.stringify(body);
    const req = request(`${origin}/api/forgejo/connector/${endpoint}`, {
      method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(serialized),
        ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(serialized);
  });
  const queued = async () => {
    await prisma.forgejoConnectorRequest.create({ data: {
      integrationId: integration.id, method: "GET", expiresAt: new Date(Date.now() + 60_000),
      requestEnc: encryptJson({ method: "GET", path: "/api/v1/repos/team/project/contents/large.txt", maxBytes: 16 * 1024 * 1024 }),
    } });
    const poll = await post("poll", { host, username: "bot", capacity: 4 });
    assert.equal(poll.status, 200);
    return (await poll.json()).commands[0];
  };
  const command = await queued();
  const body = JSON.stringify({ content: Buffer.alloc(8 * 1024 * 1024, "x").toString("base64"), encoding: "base64" });
  const result = { id: command.id, leaseToken: command.leaseToken, result: { body, headers: {} } };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 10 * 1024 * 1024);
  assert.equal((await post("result", result, false)).status, 401);
  const response = await post("result", result);
  assert.equal(response.status, 200, await response.text());
  const stored = await prisma.forgejoConnectorRequest.findUniqueOrThrow({ where: { id: command.id } });
  const decoded = decryptJson<{ result: { body: string } }>(stored.responseEnc!);
  assert.equal(decoded.result.body.length, body.length);
  assert.equal(decoded.result.body, body);
  const oversized = await queued();
  assert.equal((await post("result", { id: oversized.id, leaseToken: oversized.leaseToken,
    result: { body: "x".repeat(16 * 1024 * 1024 + 1), headers: {} },
  })).status, 400);
  assert.equal((await prisma.forgejoConnectorRequest.findUniqueOrThrow({ where: { id: oversized.id } })).responseEnc, null);
} finally {
  server.kill();
  await server.exited;
  const output = await logs;
  console.log(output.join("\n"));
  if (organizationId) await prisma.organization.delete({ where: { id: organizationId } });
  await prisma.$disconnect();
}
