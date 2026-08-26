#!/usr/bin/env bash
# Back up everything this deployment needs to be readable again. rayf P-0007 C7.
#
#   ./backup.sh [destination-dir]        # default: ./backups
#   ./backup.sh --with-secrets           # also copies .env -- read the warning
#   ./backup.sh --allow-live             # accept a skewed archive; see the refusal below
#
# "Readable again" is a higher bar than "the files are somewhere". Restoring a
# PostgreSQL dump next to a Qdrant volume gets you a database whose review rows
# reference vectors that may have been written by a different embedding model,
# encrypted columns nobody holds the key for, and an image digest that has moved.
# So this records the things that decide readability alongside the data, and
# ./restore.sh refuses rather than half-working when one of them disagrees.
#
# What is captured, and why each one:
#
#   postgres.dump    the review and index state. `pg_dump -Fc` runs in a single
#                    transaction snapshot, so it is consistent without stopping
#                    the service.
#   qdrant/          a Qdrant storage snapshot, taken through its own snapshot
#                    API rather than by copying the volume underneath a running
#                    process, which is how you get a torn segment file.
#   docker-compose.yml   the deployment pins. Digests, not tags: restoring against
#                    "whatever :latest is now" is not restoring.
#   manifest.json    embedding provider/model/dim, Qdrant collections and their
#                    vector sizes, and SHA-256 fingerprints of the secrets. The
#                    fingerprints are what let a restore say "this is the wrong
#                    ENCRYPTION_KEY" instead of returning corrupt plaintext.
#
# SECRETS ARE NOT INCLUDED BY DEFAULT. `--with-secrets` writes `secrets.env` 0600
# into the archive; without it the archive holds fingerprints only and the
# operator must supply `.env` at restore time. Deliberate: a backup that carries
# its own keys is a single file that decrypts itself, and these archives get
# copied around. Losing .env with no `--with-secrets` copy anywhere means the
# encrypted columns are gone for good -- so keep one, stored apart from the data.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${DIR}/backups"
WITH_SECRETS=0
ALLOW_LIVE=0
for arg in "$@"; do
  case "$arg" in
    --with-secrets) WITH_SECRETS=1 ;;
    --allow-live) ALLOW_LIVE=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) DEST_ROOT="$arg" ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "no .env beside the compose file" >&2; exit 1; }
# shellcheck source=/dev/null
set -a; . "$DIR/.env"; set +a

cd "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST_ROOT/octopus-$STAMP"
# Built in a sibling directory and moved into place at the end. A run that dies
# half way leaves `.partial`, which nobody will mistake for an archive -- whereas a
# half-written `octopus-<stamp>/` looks exactly like a complete one, and the
# timestamp has one-second resolution, so two overlapping runs would otherwise
# publish into the same directory.
STAGE="$DEST_ROOT/.octopus-$STAMP.partial.$$"
mkdir -p "$STAGE/qdrant"
echo "backing up to $OUT"

# The dump, the Qdrant snapshot and the row counts are three separate reads. They
# only describe one state if nothing is writing, which is why this refuses rather
# than silently recording a skewed archive. `./probe-ingress.sh` and R-0004 describe
# the pause: `docker compose stop ingress`, then wait for these to drain.
inflight="$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
  "select count(*) from pull_requests where status in ('reviewing','queued')" 2>/dev/null \
  | tr -d '[:space:]')"
if [ -n "$inflight" ] && [ "$inflight" != "0" ]; then
  if [ "$ALLOW_LIVE" -eq 1 ]; then
    echo "  WARNING: $inflight review(s) in flight; the dump, the snapshot and the counts"
    echo "           are three reads of a moving target and may not agree."
  else
    rm -rf "$STAGE"
    echo "refusing: $inflight review(s) are in flight." >&2
    echo "Pause admission first (docker compose stop ingress) and let them finish, or" >&2
    echo "pass --allow-live to accept an archive whose three reads may disagree." >&2
    exit 1
  fi
fi

# --- PostgreSQL -------------------------------------------------------------
# -Fc (custom format) rather than plain SQL: it is compressed, and pg_restore can
# read it selectively, which is what makes a partial recovery possible at all.
echo "  postgres: dumping $POSTGRES_DB"
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$STAGE/postgres.dump"
[ -s "$STAGE/postgres.dump" ] || { echo "pg_dump produced an empty file" >&2; exit 1; }

# --- Qdrant -----------------------------------------------------------------
# Spoken over /dev/tcp from inside the container. The image has neither curl nor
# wget, and the service publishes no host port (C4), so this is the available
# path -- the same one the compose healthcheck uses.
qdrant_http() {
  local method="$1" path="$2"
  docker compose exec -T qdrant bash -c "
    exec 3<>/dev/tcp/127.0.0.1/6333
    printf '$method $path HTTP/1.0\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n' >&3
    cat <&3
  " | sed -n '/^\r\{0,1\}$/,$p' | tail -n +2
}

echo "  qdrant: reading collections"
collections=$(qdrant_http GET /collections | jq -r '.result.collections[]?.name' || true)
collection_info='[]'
for c in $collections; do
  info=$(qdrant_http GET "/collections/$c")
  collection_info=$(jq -n --argjson acc "$collection_info" --arg name "$c" --argjson info "$info" '
    $acc + [{
      name: $name,
      points: ($info.result.points_count // null),
      # Both shapes appear: a single unnamed vector, or a named-vector map. Recorded
      # as given rather than normalised, because a restore comparing them has to see
      # the same thing the collection actually declares.
      vectors: ($info.result.config.params.vectors // null)
    }]')
done

echo "  qdrant: creating a storage snapshot"
snap=$(qdrant_http POST /snapshots | jq -r '.result.name // empty')
[ -n "$snap" ] || { echo "qdrant refused to create a snapshot" >&2; exit 1; }
# Registered BEFORE the copy. Snapshots live in the data volume, so one left behind
# grows the deployment's own disk -- and a copy that fails is exactly when the
# script exits early, which is exactly when the cleanup after it would not run.
cleanup_snapshot() {
  qdrant_http DELETE "/snapshots/$snap" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup_snapshot EXIT
qdrant_cid=$(docker compose ps -q qdrant)
docker cp "$qdrant_cid:/qdrant/snapshots/$snap" "$STAGE/qdrant/$snap"
echo "  qdrant: $snap"

# --- Row counts -------------------------------------------------------------
# Recorded so the restore can compare rather than merely count. "3 rows restored"
# is not evidence of anything on its own; "3 recorded, 3 restored" is, and it
# stays evidence when the true answer is zero.
echo "  postgres: counting rows"
row_counts='{}'
for table in organizations repositories pull_requests review_attempts; do
  n=$(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
        "select count(*) from \"$table\"" 2>/dev/null | tr -d '[:space:]')
  [ -n "$n" ] || continue   # table absent in this schema version
  row_counts=$(jq -n --argjson acc "$row_counts" --arg t "$table" --argjson n "$n" '$acc + {($t): $n}')
done

# --- Pins and configuration -------------------------------------------------
cp docker-compose.yml "$STAGE/docker-compose.yml"

fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# The key the application would actually use, not the variable that happens to be
# set. `apps/web/lib/crypto.ts` reads OCTOPUS_DATA_KEY and falls back to
# sha256(BETTER_AUTH_SECRET), so two deployments -- one with the key set explicitly,
# one relying on the fallback -- can hold the same key under different variables.
# Fingerprinting the resolved value is what lets a restore compare them.
resolved_data_key() {
  if [ -n "${OCTOPUS_DATA_KEY:-}" ]; then
    printf '%s' "$OCTOPUS_DATA_KEY"
  elif [ -n "${BETTER_AUTH_SECRET:-}" ]; then
    printf '%s' "$BETTER_AUTH_SECRET" | sha256sum | cut -d' ' -f1
  fi
}

# The embedding values are recorded AS SET, with unset spelled out, because the
# defaults live in application code (apps/web/lib/embed-config.ts) and change with
# the image. "unset" plus the pinned digest is reproducible; a default resolved
# here by this script would be this script's guess.
jq -n \
  --arg stamp "$STAMP" \
  --arg pg_db "$POSTGRES_DB" \
  --arg pg_user "$POSTGRES_USER" \
  --arg fp_data "$(fingerprint "$(resolved_data_key)")" \
  --arg fp_auth "$(fingerprint "${BETTER_AUTH_SECRET:-}")" \
  --arg fp_pgpass "$(fingerprint "${POSTGRES_PASSWORD:-}")" \
  --arg embed_provider "${OCTOPUS_EMBED_PROVIDER:-unset}" \
  --arg embed_model "${OCTOPUS_EMBED_MODEL:-unset}" \
  --arg embed_dim "${OCTOPUS_EMBED_DIM:-unset}" \
  --arg snapshot "$snap" \
  --arg with_secrets "$WITH_SECRETS" \
  --argjson collections "$collection_info" \
  --argjson row_counts "$row_counts" \
  --argjson images "$(docker compose config --format json | jq '[.services | to_entries[] | {service: .key, image: .value.image}]')" \
  '{
    taken_at: $stamp,
    postgres: { database: $pg_db, user: $pg_user, dump: "postgres.dump", row_counts: $row_counts },
    qdrant: { snapshot: ("qdrant/" + $snapshot), collections: $collections },
    embedding: { provider: $embed_provider, model: $embed_model, dim: $embed_dim },
    images: $images,
    secret_fingerprints: {
      note: "sha256, first 16 hex chars. Identity check only -- not reversible.",
      resolved_data_key: $fp_data,
      BETTER_AUTH_SECRET: $fp_auth,
      POSTGRES_PASSWORD: $fp_pgpass
    },
    secrets_included: ($with_secrets == "1")
  }' > "$STAGE/manifest.json"

if [ "$WITH_SECRETS" -eq 1 ]; then
  cp .env "$STAGE/secrets.env"
  chmod 600 "$STAGE/secrets.env"
  echo "  secrets: secrets.env written -- this archive now decrypts itself. Store it accordingly."
else
  echo "  secrets: fingerprints only. Keep a copy of .env somewhere else or the encrypted columns are unrecoverable."
fi

# `docker cp` writes with its own permissions, not the umask, so the snapshot lands
# world-readable. Tighten the whole tree rather than that one file: the next thing
# copied out of a container would have the same problem.
chmod -R go-rwx "$STAGE"

( cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )

# Published by rename, so `octopus-<stamp>/` appears complete or not at all. The
# trap still deletes the snapshot inside the container; there is no longer a stage
# directory for it to remove.
mv "$STAGE" "$OUT"
echo "done: $OUT ($(du -sh "$OUT" | cut -f1))"
