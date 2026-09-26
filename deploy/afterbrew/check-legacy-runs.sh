#!/usr/bin/env bash
# Read-only. Run before deploying a version that adds a run-binding check
# (rayf, `reviewer.ts`'s `runBindingMismatch`) that treats a `review_runs` row
# with no recorded `headSha` as unsafe and supersedes it without ever running.
#
#   ./check-legacy-runs.sh
#
# `reviewRequestVersion` is a new column: every row written before its
# migration has it NULL, and that alone is treated as an unbound wildcard --
# those runs still execute. A NULL `headSha` is different: it means some
# caller never threaded a head through this run at all, which the check
# treats as unsafe on principle, not merely "old". This script exists to tell
# the operator which case a non-terminal row is in BEFORE deploy, since the
# fix drains rather than migrates that data -- restarting `web` on the new
# image lets its queue workers finish first.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/.env" ] || { echo "no .env beside the compose file" >&2; exit 1; }
# shellcheck source=/dev/null
set -a; . "$DIR/.env"; set +a
cd "$DIR"

read -r non_terminal non_terminal_null_head < <(docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
  select count(*) filter (where \"terminalAt\" is null),
         count(*) filter (where \"terminalAt\" is null and \"headSha\" is null)
  from review_runs
" | tr '|' ' ')

echo "non-terminal review_runs: ${non_terminal:-0}"
echo "non-terminal review_runs with no recorded head: ${non_terminal_null_head:-0}"

if [ "${non_terminal_null_head:-0}" != "0" ]; then
  echo
  echo "These will supersede without running the moment the new image claims" \
    "them -- not silently: each writes a terminalDetail naming what it found" \
    "current instead. Drain the queue first (pause admission, let workers" \
    "finish, then deploy) if that is not acceptable for whatever they are." >&2
fi
