#!/usr/bin/env bash
# Back up everything this deployment needs to be readable again. rayf P-0007 C7.
#
#   ./backup.sh [destination-dir]        # default: ./backups
#   ./backup.sh --with-secrets           # also copies .env -- read the warning
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
for arg in "$@"; do
  case "$arg" in
    --with-secrets) WITH_SECRETS=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) DEST_ROOT="$arg" ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "no .env beside the compose file" >&2; exit 1; }
set -a; . "$DIR/.env"; set +a

cd "$DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST_ROOT/octopus-$STAMP"
mkdir -p "$OUT/qdrant"
echo "backing up to $OUT"

# --- PostgreSQL -------------------------------------------------------------
# -Fc (custom format) rather than plain SQL: it is compressed, and pg_restore can
# read it selectively, which is what makes a partial recovery possible at all.
echo "  postgres: dumping $POSTGRES_DB"
docker compose exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$OUT/postgres.dump"
[ -s "$OUT/postgres.dump" ] || { echo "pg_dump produced an empty file" >&2; exit 1; }

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
qdrant_cid=$(docker compose ps -q qdrant)
docker cp "$qdrant_cid:/qdrant/snapshots/$snap" "$OUT/qdrant/$snap"
# Delete it inside the container: snapshots live in the data volume, so keeping
# them there doubles the deployment's disk for every backup ever taken.
qdrant_http DELETE "/snapshots/$snap" >/dev/null || true
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
cp docker-compose.yml "$OUT/docker-compose.yml"

fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# The embedding values are recorded AS SET, with unset spelled out, because the
# defaults live in application code (apps/web/lib/embed-config.ts) and change with
# the image. "unset" plus the pinned digest is reproducible; a default resolved
# here by this script would be this script's guess.
jq -n \
  --arg stamp "$STAMP" \
  --arg pg_db "$POSTGRES_DB" \
  --arg pg_user "$POSTGRES_USER" \
  --arg fp_enc "$(fingerprint "${ENCRYPTION_KEY:-}")" \
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
      ENCRYPTION_KEY: $fp_enc,
      BETTER_AUTH_SECRET: $fp_auth,
      POSTGRES_PASSWORD: $fp_pgpass
    },
    secrets_included: ($with_secrets == "1")
  }' > "$OUT/manifest.json"

if [ "$WITH_SECRETS" -eq 1 ]; then
  cp .env "$OUT/secrets.env"
  chmod 600 "$OUT/secrets.env"
  echo "  secrets: secrets.env written -- this archive now decrypts itself. Store it accordingly."
else
  echo "  secrets: fingerprints only. Keep a copy of .env somewhere else or the encrypted columns are unrecoverable."
fi

# `docker cp` writes with its own permissions, not the umask, so the snapshot lands
# world-readable. Tighten the whole tree rather than that one file: the next thing
# copied out of a container would have the same problem.
chmod -R go-rwx "$OUT"

( cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
echo "done: $OUT ($(du -sh "$OUT" | cut -f1))"
