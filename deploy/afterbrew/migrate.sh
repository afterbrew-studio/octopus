#!/usr/bin/env bash
# Apply Prisma migrations to the deployed database.
#
# The runtime image does not carry migrations, and this deployment deliberately
# publishes no PostgreSQL port (rayf P-0007 C4), so there is nothing to connect to
# from the host. Both facts are intentional and together they mean the migration
# has to run INSIDE the compose network.
#
# So: a throwaway container joined to that network, with the schema mounted
# read-only. Nothing is installed on the host, nothing is left behind, and the
# database stays unreachable from outside the network the whole time.
#
#   ./migrate.sh /path/to/octopus/packages/db/prisma
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRISMA_DIR="${1:-$DIR/prisma}"
NETWORK="${OCTOPUS_NETWORK:-octopus-afterbrew_default}"
NODE_IMAGE="${NODE_IMAGE:-node:22-alpine}"
# BASELINE=1 for a database that has never been built. See the note in the runner.
BASELINE="${BASELINE:-0}"

[ -f "$PRISMA_DIR/schema.prisma" ] || { echo "no schema.prisma under $PRISMA_DIR" >&2; exit 1; }
[ -d "$PRISMA_DIR/migrations" ] || { echo "no migrations/ under $PRISMA_DIR" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "no .env; run ./generate-secrets.sh first" >&2; exit 1; }

# Read the credentials without echoing them, and build the URL inside the
# container rather than passing it on a command line where `ps` would show it.
set -a; . "$DIR/.env"; set +a

docker network inspect "$NETWORK" >/dev/null 2>&1 || {
  echo "network $NETWORK not found; is the stack up?" >&2
  exit 1
}

echo "applying migrations from $PRISMA_DIR ($(find "$PRISMA_DIR/migrations" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') present)"
# Prisma 7 takes the datasource url from a config file, not from the schema --
# `packages/db/prisma/schema.prisma` has a bare `datasource db { provider }` and
# the url lives in `prisma.config.ts`. That file imports dotenv and reads a .env
# two directories up, which does not exist in a throwaway container, so a minimal
# equivalent is written here instead. It reads the same DATABASE_URL env var.
docker run --rm \
  --network "$NETWORK" \
  -v "$PRISMA_DIR:/work/prisma:ro" \
  -e DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}" \
  -e BASELINE="$BASELINE" \
  -w /work \
  "$NODE_IMAGE" \
  sh -c '
    set -e
    # Installed into /work rather than run through npx: the config file imports
    # `prisma/config`, and npx resolves the CLI in a temp directory where that
    # import cannot be found from /work.
    npm init -y >/dev/null 2>&1
    npm install --no-audit --no-fund --loglevel=error prisma@7 >/dev/null
    cat > /work/prisma.config.mjs <<CONFIG
import { defineConfig, env } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
CONFIG
    PRISMA=./node_modules/.bin/prisma
    # A fresh database cannot be built from migrations/ alone. There is no
    # baseline: 35 migrations carry only 10 CREATE TABLE statements between them,
    # and the earliest one alters `review_issues`, which nothing creates. They are
    # increments on a schema that `db push` produces from schema.prisma.
    #
    # So with BASELINE=1: push the schema, then record every existing migration as
    # applied, so a later `migrate deploy` runs only what is genuinely new rather
    # than replaying history against tables that already exist.
    if [ "$BASELINE" = "1" ]; then
      echo "baselining: pushing schema, then recording migrations as applied"
      $PRISMA db push --config /work/prisma.config.mjs --accept-data-loss
      for m in /work/prisma/migrations/*/; do
        $PRISMA migrate resolve --applied "$(basename "$m")" --config /work/prisma.config.mjs >/dev/null 2>&1 || true
      done
      echo "baseline complete"
    else
      $PRISMA migrate deploy --config /work/prisma.config.mjs
    fi
  '
