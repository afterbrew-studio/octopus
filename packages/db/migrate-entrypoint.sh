#!/bin/sh
# Applies Prisma migrations to $DATABASE_URL. BASELINE=1 builds a never-built database.
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"

# Prisma 7 reads the datasource url from a config file. packages/db/prisma.config.ts
# imports dotenv and a .env that does not exist in this image.
cat > prisma.config.mjs <<'CONFIG'
import { defineConfig, env } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
CONFIG

PRISMA="./node_modules/.bin/prisma"

if [ "${BASELINE:-0}" = "1" ]; then
  # `db push` drops whatever the schema does not describe, so it is only safe on an empty database.
  tables="$(node - <<'JS'
const { Client } = require("pg");
const client = new Client({ connectionString: process.env.DATABASE_URL });
client
  .connect()
  .then(() =>
    client.query("select count(*)::int as n from information_schema.tables where table_schema = 'public'"),
  )
  .then((result) => {
    console.log(result.rows[0].n);
    return client.end();
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
JS
)"
  if [ "$tables" != "0" ]; then
    echo "refusing to baseline: the database already has $tables table(s) in public." >&2
    echo "BASELINE=1 runs \`prisma db push\`, which drops whatever the schema does not" >&2
    echo "describe. Run without BASELINE to apply new migrations to an existing database." >&2
    exit 1
  fi

  # No baseline migration exists: the migrations are increments on a schema that
  # `db push` produces, so each one is recorded as applied instead of replayed.
  echo "baselining: pushing schema, then recording migrations as applied"
  "$PRISMA" db push --config prisma.config.mjs
  for dir in prisma/migrations/*/; do
    "$PRISMA" migrate resolve --applied "$(basename "$dir")" --config prisma.config.mjs >/dev/null
  done
  echo "baseline complete"
else
  "$PRISMA" migrate deploy --config prisma.config.mjs
fi
