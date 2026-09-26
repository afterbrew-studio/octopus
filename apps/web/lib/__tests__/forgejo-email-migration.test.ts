import { expect, it } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";

async function seededTemplates(): Promise<{ slug: string; body: string }[]> {
  const child = Bun.spawn([process.execPath, new URL("./fixtures/forgejo-email-seed-harness.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(code, err).toBe(0);
  return JSON.parse(out);
}

it("seeds missing email templates and preserves customized records", async () => {
  expect((await seededTemplates()).length).toBeGreaterThan(0);
});

const databaseUrl = process.env.FORGEJO_EMAIL_TEST_DATABASE_URL;

// Run against a disposable PostgreSQL database; a temporary table shadows any
// real email table, and is dropped at the end of the transaction.
it.skipIf(!databaseUrl)("updates default Forgejo emails without changing custom content or delivery settings", async () => {
  expect(new URL(databaseUrl!).pathname).toMatch(/test/i);
  const sql = new SQL(databaseUrl!);
  const migrations = [
    "20260919153000_forgejo_email_templates",
    "20260919213000_forgejo_connector_email_templates",
  ].map(name => readFileSync(new URL(`../../../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8"));
  const seeds = await seededTemplates();
  const parse = (migration: string) => [...migration.matchAll(/SET "body" = \$forgejo_template\$([\s\S]*?)\$forgejo_template\$,[\s\S]*?WHERE "slug" = '([^']+)'[\s\S]*?"body" = \$forgejo_template\$([\s\S]*?)\$forgejo_template\$/g)];
  const previousUpdates = parse(migrations[0]);
  const updates = parse(migrations[1]);

  try {
    await sql.begin(async (tx) => {
      await tx`CREATE TEMP TABLE email_templates (
        id text, slug text, body text, system boolean, enabled boolean,
        subject text DEFAULT 'Custom subject', "fromEmail" text DEFAULT 'custom@example.test',
        "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP
      ) ON COMMIT DROP`;
      for (const [, , slug, oldBody] of updates) {
        const previous = previousUpdates.find(update => update[2] === slug)!;
        for (const variant of ["default", "custom", "non-system", "disabled"]) {
          const body = variant === "custom" ? `${oldBody}\nPersonal note` : oldBody;
          await tx`INSERT INTO email_templates (id, slug, body, system, enabled)
            VALUES (${`${slug}:${variant}`}, ${slug}, ${body}, ${variant !== "non-system"}, ${variant !== "disabled"})`;
        }
        await tx`INSERT INTO email_templates (id, slug, body, system, enabled)
          VALUES (${`${slug}:pre-forgejo`}, ${slug}, ${previous[3]}, true, true)`;
      }
      // Check both an existing Forgejo installation and a full migration from
      // older defaults. Running the chain twice checks retry behavior too.
      for (let pass = 0; pass < 2; pass++) {
        for (const migration of migrations) await tx.unsafe(migration).simple();
      }
      expect((await tx`SELECT COUNT(*)::int AS count FROM email_templates`)[0].count).toBe(15);
      for (const slug of ["welcome", "get-started-new-user", "connect-repo-reminder"]) {
        const nextBody = seeds.find(template => template.slug === slug)!.body;
        const oldBody = updates.find(update => update[2] === slug)![3];
        const rows = await tx`SELECT * FROM email_templates WHERE slug = ${slug}`;
        expect(rows).toHaveLength(5);
        for (const row of rows) {
          const variant = row.id.split(":")[1];
          const expectedBody = variant === "custom" ? `${oldBody}\nPersonal note`
            : variant === "non-system" ? oldBody : nextBody;
          expect(row.body).toBe(expectedBody);
          expect(row.enabled).toBe(variant !== "disabled");
          expect(row.subject).toBe("Custom subject");
          expect(row.fromEmail).toBe("custom@example.test");
        }
      }
    });
  } finally {
    await sql.close();
  }
});
