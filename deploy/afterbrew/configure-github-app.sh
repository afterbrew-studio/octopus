#!/usr/bin/env bash
# Register the GitHub App with the deployment, in the database.
#
#   ./configure-github-app.sh --app-id 123 --slug my-app --key /path/to/app.pem \
#     [--client-id Iv23...] [--webhook-secret whsec_...]
#
# WHY THE DATABASE AND NOT `.env`. `github-app-config.ts` reads the App from the
# SystemConfig singleton first and falls back to `GITHUB_APP_*` environment
# variables. The env path cannot work on a PREBUILT image, because the slug is read
# from `NEXT_PUBLIC_GITHUB_APP_SLUG` and Next.js inlines every `NEXT_PUBLIC_*`
# reference at build time -- including in server code. Setting it at runtime looks
# like configuration and changes nothing, and the symptom is a dashboard with no
# "Connect GitHub" button and an install route that redirects to
# `?error=github_app_not_configured` while the app id and private key are plainly
# present in the container's environment.
#
# The database path has no such problem, and it is what the product's own manifest
# flow writes. This does the same write, for an App that already exists.
#
# Encryption matches `crypto.ts` exactly: AES-256-GCM under the resolved data key,
# emitted as base64url(iv[12] || tag[16] || ciphertext). The key is
# OCTOPUS_DATA_KEY, or sha256(BETTER_AUTH_SECRET) when that is unset -- the same
# fallback the application applies.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_IMAGE="${NODE_IMAGE:-node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32}"

APP_ID=""; SLUG=""; CLIENT_ID=""; KEY_PATH=""; WEBHOOK_SECRET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app-id) APP_ID="$2"; shift 2 ;;
    --slug) SLUG="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --key) KEY_PATH="$2"; shift 2 ;;
    --webhook-secret) WEBHOOK_SECRET="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ -n "$APP_ID" ] && [ -n "$SLUG" ] && [ -n "$KEY_PATH" ] \
  || { echo "usage: --app-id ID --slug SLUG --key PEM [--client-id ID] [--webhook-secret S]" >&2; exit 2; }
[ -f "$KEY_PATH" ] || { echo "no private key at $KEY_PATH" >&2; exit 1; }
[ -f "$DIR/.env" ] || { echo "no .env beside the compose file" >&2; exit 1; }

cd "$DIR"
# shellcheck source=/dev/null
set -a; . "$DIR/.env"; set +a

# The key the application resolves, not whichever variable happens to be set.
if [ -n "${OCTOPUS_DATA_KEY:-}" ]; then
  DATA_KEY_HEX="$OCTOPUS_DATA_KEY"
else
  DATA_KEY_HEX="$(printf '%s' "${BETTER_AUTH_SECRET:?no OCTOPUS_DATA_KEY and no BETTER_AUTH_SECRET}" \
    | sha256sum | cut -d' ' -f1)"
fi

# Encrypted in a throwaway container so nothing is installed on the host, and the
# values arrive as inherited environment rather than in the argument vector, where
# `ps` would show them.
encrypt() {
  PLAINTEXT="$1" DATA_KEY_HEX="$DATA_KEY_HEX" docker run --rm -i \
    -e PLAINTEXT -e DATA_KEY_HEX "$NODE_IMAGE" node -e '
      const { createCipheriv, randomBytes } = require("node:crypto");
      const key = Buffer.from(process.env.DATA_KEY_HEX.trim(), "hex");
      if (key.length !== 32) throw new Error("data key must be 32 bytes of hex");
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(Buffer.from(process.env.PLAINTEXT, "utf8")), c.final()]);
      process.stdout.write(Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url"));
    '
}

KEY_ENC="$(encrypt "$(cat "$KEY_PATH")")"
[ -n "$KEY_ENC" ] || { echo "encryption produced nothing" >&2; exit 1; }
SECRET_ENC=""
[ -n "$WEBHOOK_SECRET" ] && SECRET_ENC="$(encrypt "$WEBHOOK_SECRET")"

psql() { docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"; }

# Guarded exactly as saveGithubAppConfig guards it: write only while no App is
# configured, so this can never clobber one that is already there. Re-running is a
# no-op rather than a silent overwrite.
existing="$(psql 'select coalesce("githubAppId", '"''"') from system_config where id = '"'singleton'"'' | tr -d '[:space:]')"
if [ -n "$existing" ]; then
  echo "an App is already configured (id $existing); refusing to overwrite"
  exit 1
fi

psql "insert into system_config (id, \"githubAppId\", \"githubAppSlug\", \"githubAppClientId\",
        \"githubAppHtmlUrl\", \"githubAppPrivateKeyEnc\", \"githubAppWebhookSecretEnc\", \"updatedAt\")
      values ('singleton', '$APP_ID', '$SLUG', $( [ -n "$CLIENT_ID" ] && echo "'$CLIENT_ID'" || echo NULL ),
        'https://github.com/apps/$SLUG', '$KEY_ENC',
        $( [ -n "$SECRET_ENC" ] && echo "'$SECRET_ENC'" || echo NULL ), now())
      on conflict (id) do update set
        \"githubAppId\" = excluded.\"githubAppId\",
        \"githubAppSlug\" = excluded.\"githubAppSlug\",
        \"githubAppClientId\" = excluded.\"githubAppClientId\",
        \"githubAppHtmlUrl\" = excluded.\"githubAppHtmlUrl\",
        \"githubAppPrivateKeyEnc\" = excluded.\"githubAppPrivateKeyEnc\",
        \"githubAppWebhookSecretEnc\" = excluded.\"githubAppWebhookSecretEnc\",
        \"updatedAt\" = now()
      where system_config.\"githubAppId\" is null" >/dev/null

wrote="$(psql 'select "githubAppSlug" from system_config where id = '"'singleton'"'' | tr -d '[:space:]')"
[ "$wrote" = "$SLUG" ] || { echo "the row did not take: slug reads '$wrote'" >&2; exit 1; }
echo "configured $SLUG (app $APP_ID)${SECRET_ENC:+, with a webhook secret}"

# The resolver memoizes for 30s. Recreating is faster than explaining the delay.
docker compose up -d --force-recreate web >/dev/null
echo "web recreated; give it ~30s"
