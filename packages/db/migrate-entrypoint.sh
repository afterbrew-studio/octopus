#!/bin/sh
# Applies pending Prisma migrations to $DATABASE_URL. An empty database fails here:
# the migrations are increments, and a new deployment starts from a restored backup.
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

exec ./node_modules/.bin/prisma migrate deploy --config prisma.config.mjs
