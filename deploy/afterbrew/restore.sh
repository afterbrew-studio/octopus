#!/usr/bin/env bash
# Restore a backup into DISPOSABLE service identities and prove it is readable.
# rayf P-0007 C7.
#
#   ./restore.sh backups/octopus-20260826T005456Z
#   ./restore.sh <archive> --env /path/to/.env      # keys other than the live ones
#   ./restore.sh <archive> --keep                   # leave the restored stack up
#
# Disposable is the point. This never writes to the running deployment: it brings
# up a second compose project, with its own volumes, under the digests the archive
# recorded, and tears it down again. Nothing here can reach GitHub -- the `web`
# service is deliberately NOT started, so there is no worker, no queue consumer and
# no token in play. "Restore into disposable identities before enabling GitHub
# writes" is the requirement; not starting the thing that writes is how it is met.
#
# What it proves, and what each failure would otherwise look like:
#
#   archive integrity   a truncated dump restores partially and looks fine
#   key identity        the wrong ENCRYPTION_KEY decodes encrypted columns to
#                       nothing; the restore "succeeds" and the data is gone
#   embedding dim       a collection restored at a different dim than the running
#                       embedder produces gets a Qdrant 400 on the first upsert,
#                       long after the restore was called a success
#   row readability     a dump that restores with zero rows is not a backup
#
# Each of those is checked here and named. A silent success is the failure mode
# this exists to remove.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARCHIVE=""
ENV_FILE="$DIR/.env"
KEEP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

fail() { echo "RESTORE FAILED: $*" >&2; exit 1; }

[ -n "$ARCHIVE" ] || fail "usage: ./restore.sh <archive-dir> [--env FILE] [--keep]"
ARCHIVE="$(cd "$ARCHIVE" 2>/dev/null && pwd)" || fail "no such archive directory"
[ -f "$ARCHIVE/manifest.json" ] || fail "no manifest.json in $ARCHIVE -- not an archive this script wrote"
command -v jq >/dev/null || fail "jq is required"

echo "== archive integrity =="
( cd "$ARCHIVE" && sha256sum -c --quiet SHA256SUMS ) \
  || fail "checksums do not match. A file in this archive changed or was truncated since it was written; a partial dump restores without error and looks complete."
echo "  ok    every file matches SHA256SUMS"

echo "== key identity =="
[ -f "$ENV_FILE" ] || fail "no env file at $ENV_FILE. Without the original keys the encrypted columns cannot be read, and a restore that skipped this check would look successful."

# Read as DATA, never sourced. This file can be `secrets.env` from an archive, and
# sourcing an archive means an archive can run commands as whoever runs the restore.
env_value() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
[ -n "$POSTGRES_USER" ] && [ -n "$POSTGRES_DB" ] || fail "$ENV_FILE has no POSTGRES_USER/POSTGRES_DB"

fingerprint() { printf '%s' "$1" | sha256sum | cut -c1-16; }

# The key the application would actually use. `apps/web/lib/crypto.ts` reads
# OCTOPUS_DATA_KEY and falls back to sha256(BETTER_AUTH_SECRET), so checking either
# variable on its own answers the wrong question: an env file can carry the right
# variable and the wrong key, or the right key under the other name.
resolved_data_key() {
  local dk auth
  dk="$(env_value OCTOPUS_DATA_KEY)"
  if [ -n "$dk" ]; then printf '%s' "$dk"; return; fi
  auth="$(env_value BETTER_AUTH_SECRET)"
  [ -n "$auth" ] && printf '%s' "$auth" | sha256sum | cut -d' ' -f1
}

check_key() {
  local name="$1" value="${2:-}"
  local want have
  want=$(jq -r --arg k "$name" '.secret_fingerprints[$k] // empty' "$ARCHIVE/manifest.json")
  [ -n "$want" ] || { echo "  skip  $name not recorded in this archive"; return; }
  [ -n "$value" ] || fail "$name is not available from $ENV_FILE. The archive was taken with one (fingerprint $want)."
  have=$(fingerprint "$value")
  [ "$have" = "$want" ] \
    || fail "$name does not match this archive (env $have, archive $want). Restoring anyway would decode encrypted columns to nothing and report success."
  echo "  ok    $name matches ($have)"
}
check_key resolved_data_key "$(resolved_data_key)"
check_key BETTER_AUTH_SECRET "$(env_value BETTER_AUTH_SECRET)"

# --- the disposable stack ----------------------------------------------------
STAMP="$(jq -r .taken_at "$ARCHIVE/manifest.json")"
# Lowercased with tr rather than ${VAR,,}: compose refuses an uppercase project
# name, and the bash 4 expansion would fail on a host still shipping bash 3.
PROJECT="octopus-restore-$(printf '%s' "$STAMP" | tr '[:upper:]' '[:lower:]')"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
cleanup() {
  if [ "$KEEP" -eq 1 ]; then
    echo
    echo "left running as project '$PROJECT'. Remove it with:"
    echo "  docker compose -p $PROJECT -f $WORK/compose.yml down -v"
    return
  fi
  docker compose -p "$PROJECT" -f "$WORK/compose.yml" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The digests come from the manifest, not from the current compose file: the point
# of restoring is to read data with the software that wrote it. A restore under a
# newer image is a migration test, which is a different question.
PG_IMAGE=$(jq -r '.images[] | select(.service=="postgres") | .image' "$ARCHIVE/manifest.json")
QD_IMAGE=$(jq -r '.images[] | select(.service=="qdrant") | .image' "$ARCHIVE/manifest.json")

# The manifest is data from a file, and this script runs what it names. SHA256SUMS
# proves the archive agrees with itself, not that anyone trustworthy wrote it -- so
# an image reference is accepted only in the digest-pinned form, and only from the
# registries this deployment uses. A tag, a different host, or a shell metacharacter
# is refused rather than started with the database credentials in its environment.
check_image() {
  local role="$1" image="$2"
  case "$image" in
    postgres@sha256:*|qdrant/qdrant@sha256:*) ;;
    *) fail "the archive names an unexpected $role image: '$image'. Only a digest-pinned postgres or qdrant/qdrant image is accepted here." ;;
  esac
  printf '%s' "$image" | grep -qE '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$' \
    || fail "the archive's $role image is not a well-formed digest reference: '$image'"
}
check_image postgres "$PG_IMAGE"
check_image qdrant "$QD_IMAGE"
SNAPSHOT="$ARCHIVE/$(jq -r .qdrant.snapshot "$ARCHIVE/manifest.json")"
[ -f "$SNAPSHOT" ] || fail "the manifest names a Qdrant snapshot that is not in the archive: $SNAPSHOT"

cat > "$WORK/compose.yml" <<COMPOSE
# Generated by restore.sh. Disposable: no published ports, no web service, fresh
# volumes scoped to this project. Deleted with the project on teardown.
services:
  postgres:
    image: $PG_IMAGE
    environment:
      POSTGRES_USER: \${POSTGRES_USER:?}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?}
      POSTGRES_DB: \${POSTGRES_DB:?}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \$\${POSTGRES_USER}"]
      interval: 3s
      timeout: 5s
      retries: 20
  qdrant:
    image: $QD_IMAGE
    # Full-storage snapshots have no HTTP recovery endpoint -- only per-collection
    # ones do -- so recovery happens at startup. --force-snapshot is required
    # because the default is to leave existing collections alone, and on a fresh
    # volume that would silently start empty.
    entrypoint: ["/qdrant/qdrant", "--storage-snapshot", "/restore/snapshot", "--force-snapshot"]
    volumes:
      - "$SNAPSHOT:/restore/snapshot:ro"
    healthcheck:
      test:
        [
          "CMD",
          "bash",
          "-c",
          "exec 3<>/dev/tcp/127.0.0.1/6333 && printf 'GET /readyz HTTP/1.0\r\n\r\n' >&3 && head -1 <&3 | grep -q '200 OK'",
        ]
      interval: 3s
      timeout: 5s
      retries: 20
COMPOSE

echo "== bringing up disposable project '$PROJECT' =="
docker compose -p "$PROJECT" -f "$WORK/compose.yml" --env-file "$ENV_FILE" up -d --wait >/dev/null 2>&1 \
  || fail "the disposable stack did not become healthy. Run with --keep and inspect: docker compose -p $PROJECT -f $WORK/compose.yml logs"
echo "  ok    postgres and qdrant healthy under the archive's digests"

dc() { docker compose -p "$PROJECT" -f "$WORK/compose.yml" --env-file "$ENV_FILE" "$@"; }

echo "== postgres =="
dc exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists \
  < "$ARCHIVE/postgres.dump" >/dev/null 2>"$WORK/pg.err" \
  || { sed -n '1,20p' "$WORK/pg.err" >&2; fail "pg_restore failed; see the lines above"; }

# Compared against what the archive recorded, not merely counted. A count on its
# own says nothing -- "0 rows restored" reads identically whether the source had
# none or the dump lost all of them. The comparison is what makes it evidence.
total=0
for table in $(jq -r '.postgres.row_counts // {} | keys[]' "$ARCHIVE/manifest.json"); do
  want=$(jq -r --arg t "$table" '.postgres.row_counts[$t]' "$ARCHIVE/manifest.json")
  have=$(dc exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc \
          "select count(*) from \"$table\"" 2>/dev/null | tr -d '[:space:]')
  [ -n "$have" ] || fail "table \"$table\" is not readable after the restore; the archive recorded $want rows in it"
  [ "$have" = "$want" ] \
    || fail "table \"$table\" restored $have rows, the archive recorded $want. A partially restored dump reports no error."
  echo "  ok    $table: $have rows, as recorded"
  total=$((total + have))
done
[ "$total" -gt 0 ] || echo "  note  every counted table was empty in the source, so this compared zero against zero"

echo "== qdrant =="
# Every failure here is fatal. This script does not run under `set -e`, and a `qd`
# that returned nothing -- Qdrant died after its health check, the exec failed --
# left `restored` empty, which compares equal to an archive that recorded no
# collections. A dead Qdrant would have printed "collections: [none]" and then
# "restore verified".
qd() {
  local body
  body=$(dc exec -T qdrant bash -c "
    exec 3<>/dev/tcp/127.0.0.1/6333
    printf 'GET $1 HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
    cat <&3
  " 2>/dev/null | sed -n '/^\r\{0,1\}$/,$p' | tail -n +2)
  printf '%s' "$body" | jq -e '.status == "ok"' >/dev/null 2>&1 \
    || fail "Qdrant did not answer $1 with a usable response. It was healthy when the stack came up, so it has died or is refusing queries -- and an empty answer here compares equal to an archive with no collections."
  printf '%s' "$body"
}
restored=$(qd /collections | jq -r '[.result.collections[]?.name] | sort | join(" ")')
expected=$(jq -r '[.qdrant.collections[]?.name] | sort | join(" ")' "$ARCHIVE/manifest.json")
[ "$restored" = "$expected" ] \
  || fail "collections differ. archive recorded [$expected], restore produced [$restored]. A snapshot that recovers a subset returns empty search results rather than an error."
echo "  ok    collections: [${restored:-none}]"

# The dimension check. A collection restored at a different dim than the running
# embedder produces fails on the first upsert with a Qdrant 400 -- long after
# anyone would still connect it to the restore.
env_dim="$(env_value OCTOPUS_EMBED_DIM)"
env_model="$(env_value OCTOPUS_EMBED_MODEL)"
env_provider="$(env_value OCTOPUS_EMBED_PROVIDER)"
for name in $restored; do
  want=$(jq -r --arg n "$name" '.qdrant.collections[] | select(.name==$n) | .vectors.size // .vectors[""].size // empty' "$ARCHIVE/manifest.json")
  have=$(qd "/collections/$name" | jq -r '.result.config.params.vectors.size // .result.config.params.vectors[""].size // empty')
  [ "$have" = "$want" ] \
    || fail "collection \"$name\" restored with dim ${have:-unknown}, archive recorded ${want:-unknown}."
  echo "  ok    $name: dim $have as recorded"

  # A collection can recover with the right name and the right dimension and no
  # vectors at all -- a reindex deletes points before rebuilding them, so a snapshot
  # taken mid-reindex is structurally perfect and semantically empty. Search would
  # return nothing, with no error anywhere.
  pw=$(jq -r --arg n "$name" '.qdrant.collections[] | select(.name==$n) | .points // empty' "$ARCHIVE/manifest.json")
  ph=$(qd "/collections/$name" | jq -r '.result.points_count // empty')
  if [ -n "$pw" ] && [ "$ph" != "$pw" ]; then
    fail "collection \"$name\" restored ${ph:-unknown} points, the archive recorded $pw. A snapshot can recover the right shape with none of the vectors in it."
  fi
  [ -n "$pw" ] && echo "  ok    $name: $ph points, as recorded"

  if [ -n "$env_dim" ] && [ "$env_dim" != "$have" ]; then
    fail "collection \"$name\" is dim $have but OCTOPUS_EMBED_DIM is $env_dim in $ENV_FILE. The first upsert after this restore would be rejected by Qdrant."
  fi
done

# Dimension is not identity. text-embedding-3-small and text-embedding-ada-002 are
# both 1536, and their vectors are not comparable -- so a restore that matched only
# the dimension would pass while every future query landed in a different semantic
# space, silently returning wrong results rather than failing.
arch_model=$(jq -r '.embedding.model' "$ARCHIVE/manifest.json")
arch_provider=$(jq -r '.embedding.provider' "$ARCHIVE/manifest.json")
for pair in "provider:$arch_provider:${env_provider:-unset}" "model:$arch_model:${env_model:-unset}"; do
  what="${pair%%:*}"; rest="${pair#*:}"; a="${rest%%:*}"; e="${rest#*:}"
  [ "$a" = "$e" ] \
    || fail "embedding $what differs: the archive recorded '$a', $ENV_FILE has '$e'. Two models can share a dimension and produce vectors that are not comparable."
  echo "  ok    embedding $what: $a as recorded"
done

echo
echo "restore verified: $total rows across the core tables (all matching the archive), $(printf '%s' "$restored" | wc -w | tr -d ' ') collection(s) at their recorded dimensions."
echo "no GitHub-facing service was started."
