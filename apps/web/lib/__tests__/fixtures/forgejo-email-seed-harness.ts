import { mock } from "bun:test";
import assert from "node:assert/strict";

type Template = { slug: string; body: string };
const rows = new Map<string, Template>();
mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ prisma: { emailTemplate: {
  findUnique: async ({ where }: { where: { slug: string } }) => rows.get(where.slug) ?? null,
  create: async ({ data }: { data: Template }) => { assert.ok(!rows.has(data.slug)); rows.set(data.slug, data); return data; },
} } }));
const { seedEmailTemplates } = await import("../../email-template-seeds");
const first = await seedEmailTemplates();
assert.equal(first.created, rows.size);
assert.ok(first.created > 0);
assert.equal(first.skipped, 0);
const seeded = [...rows.values()];
for (const row of seeded) rows.set(row.slug, { ...row, body: "Custom content" });
const second = await seedEmailTemplates();
assert.equal(second.created, 0);
assert.equal(second.skipped, rows.size);
assert.ok([...rows.values()].every(row => row.body === "Custom content"));
console.log(JSON.stringify(seeded));
