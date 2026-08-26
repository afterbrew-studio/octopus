# The afterbrew Octopus deployment

Upstream's `docker-compose.selfhost.yml` is not used directly. This directory is the
deployment rayf's P-0007 describes, and every difference from upstream is deliberate.

## Deploy

**Order matters.** `web` starts its queue workers and reconciliation immediately, against a
database that on a fresh deployment has no tables yet -- so it must not start until the
schema exists. Compose only waits for the datastores to be *healthy*, which they are while
still empty.

```sh
./generate-secrets.sh                 # writes .env, mode 600, never prints a value

# The runtime image carries no migrations, so bring the schema to the host from a
# checkout of the matching tag. It is read-only to everything that follows.
cp -R /path/to/octopus/packages/db/prisma ./prisma

docker compose up -d postgres qdrant  # datastores first
BASELINE=1 ./migrate.sh               # first time only; refuses if tables exist
docker compose up -d                  # now web and the ingress
```

`migrate.sh` finds the compose network by inspecting the running `postgres` container, so
it does not care what the project is called.

Then reach the dashboard over an SSH tunnel, because it binds loopback only:

```sh
ssh -N -L 43300:127.0.0.1:43300 minipc
```

## What differs from upstream, and why

**Images are pinned by digest.** Upstream defaults the web image to `:latest`, so a
`docker compose pull` can change what runs with nothing here to review. A digest cannot
move.

**PostgreSQL and Qdrant publish no host ports.** Upstream maps 43332, 43333 and 43334,
putting a database and an unauthenticated vector store on the host's interfaces. They
reach each other by service name over the compose network and need no published port at
all.

**The dashboard binds 127.0.0.1.** Not the LAN. ADR-0056 keeps it private and admits only
a signature-verified webhook route publicly. That admission is the `ingress` service --
see below.

**No credential has a default.** Upstream ships `octopus:octopus`. `${VAR:?}` here means
compose refuses to start when a variable is unset rather than quietly using a known
password.

## The ingress is an allowlist

Octopus serves about 110 API routes and a dashboard from one origin. Exactly one of them
belongs on the internet: `POST /api/github/webhook`. The `ingress` service (Caddy, digest
pinned) sits in front of `web` and answers 404 to everything else.

An allowlist rather than a blocklist, and the direction is the point. Upstream adds routes
on its own schedule; under a blocklist each new one would be exposed the moment it merged.
Under an allowlist it is unreachable until somebody edits `Caddyfile`, which is a reviewed
change.

**Four product features do not work under this allowlist**, and the failure is quiet: GitLab
and Bitbucket webhooks, Stripe billing callbacks, and Slack slash commands all need an
external callback, and all four get a 404 here. The only place that shows up is the vendor's
own delivery log. That is the right trade for a deployment reviewing one GitHub organisation
and billing nobody -- but connecting any of them means adding its route to `Caddyfile`
deliberately, not discovering the omission later.

The tunnel is pointed at the ingress, never at `web`. Like the dashboard, the ingress
publishes on loopback only -- a tunnel client runs on the host as an unprivileged process
and dials it locally, so nothing on the LAN reaches either one.

Signature verification stays in the application. Caddy cannot check an HMAC without holding
the webhook secret, and putting a second copy of that secret at the edge buys nothing: an
unsigned request is refused either way, and the app's refusal is the one under test.

### Proving it

```sh
./probe-ingress.sh
```

Asserts the whole boundary in one run: the admitted route reaches the application and is
refused there with `401 Invalid signature`; a 26 MB body is refused with `413` before the
application allocates for it; 18 other routes -- the dashboard, `/api/health`,
`/api/admin/*`, `/api/cli/*`, `/api/agent/*`, the other providers' webhooks, and the webhook
path under the wrong method -- are refused at the edge; and no datastore answers on a host
port.

A denied route has to be **404 with an empty body**. Status alone would not do: Next.js
also answers 404, with an HTML page, so a status-only check passes just as happily when the
request reached the application and the allowlist did not hold.

Measured on the deployment, 2026-08-26: 28 checks, 28 passed.

Two things it will not let you believe. The datastore-port check is a raw TCP connect via
bash's `/dev/tcp`, preceded by a guard that the probe can see an open port at all -- an
HTTP request proves nothing about PostgreSQL, and a helper that always failed would report
every port closed. And when no GitHub App exists in the database, the run says so: an
unconfigured deployment answers `401` to *every* delivery including real ones, so the 401s
prove the route is admitted and nothing about signature verification.

### What is not here yet

No tunnel. Choosing one and naming it publicly is an operator decision -- it needs an
account and a domain -- and it is deliberately the last step: the boundary should be
provable before anything from outside can reach it, not after. Whatever tunnel is chosen
points at `127.0.0.1:${OCTOPUS_INGRESS_PORT:-43310}` and nothing else, and the probe **must**
be re-run through the public name:

```sh
INGRESS_URL=https://octopus.example.invalid ./probe-ingress.sh
```

A tunnel aimed at 43300 by mistake exposes the dashboard and every API, while a loopback run
still tests 43310 and reports a clean boundary.

## Backup and restore

```sh
./backup.sh                       # -> ./backups/octopus-<stamp>/
./restore.sh backups/octopus-<stamp>
```

Being able to read the data again takes more than having the files. A PostgreSQL dump
beside a Qdrant volume gives you review rows referencing vectors a different embedding
model may have written, encrypted columns nobody holds the key for, and an image digest
that has moved. So the archive records the things that decide readability, and the restore
refuses rather than half-working when one of them disagrees.

| In the archive | Why |
|---|---|
| `postgres.dump` | `pg_dump -Fc`, a single transaction snapshot -- consistent without stopping the service |
| `qdrant/*.snapshot` | taken through Qdrant's own snapshot API, not by copying the volume under a running process |
| `docker-compose.yml` | the pins. Restoring against "whatever `:latest` is now" is not restoring |
| `manifest.json` | embedding provider/model/dim, collections with their vector sizes **and point counts**, per-table row counts, and a fingerprint of the **resolved** data key |
| `SHA256SUMS` | a truncated dump restores partially and reports no error |

**Secrets are not included by default.** `--with-secrets` writes `secrets.env` into the
archive; without it the manifest holds fingerprints only and you supply `.env` at restore
time. An archive carrying its own keys is a single file that decrypts itself, and archives
get copied around. The trade is real in the other direction too: lose `.env` with no
`--with-secrets` copy anywhere and the encrypted columns are gone. Keep one, stored apart
from the data.

### The restore is disposable

`restore.sh` never writes to the running deployment. It brings up a second compose project
with its own volumes, under the digests the archive recorded, and tears it down again. The
`web` service is deliberately **not** started -- no worker, no queue consumer, no token in
play. "Restore into disposable identities before enabling GitHub writes" is the
requirement, and not starting the thing that writes is how it is met.

Qdrant recovers at startup via `--storage-snapshot`, because full-storage snapshots have no
HTTP recovery endpoint; only per-collection ones do. `--force-snapshot` is required, since
the default is to leave existing collections alone -- on a fresh volume that would start
empty and look fine.

### What it refuses

Each of these is a silent failure elsewhere, which is why each is named here:

| Refusal | What it would otherwise be |
|---|---|
| checksum mismatch | a partial dump restores without error and looks complete |
| wrong data key | encrypted columns decode to nothing; the restore reports success |
| missing key the archive was taken with | the same, discovered much later |
| row count differs from the manifest | "0 rows restored" reads identically whether the source had none or the dump lost all of them |
| collection set or vector dim differs | a Qdrant 400 on the first upsert, long after anyone connects it to the restore |
| **point count** differs | a snapshot taken mid-reindex recovers the right shape with none of the vectors; search returns nothing, with no error |
| embedding **provider or model** differs | dimension is not identity - `text-embedding-3-small` and `ada-002` are both 1536 and produce vectors that are not comparable |
| `OCTOPUS_EMBED_DIM` disagrees with the restored collection | the same, on the first indexed commit |
| an image the manifest names is not a digest-pinned `postgres` or `qdrant/qdrant` | `SHA256SUMS` proves an archive agrees with itself, not that anyone trustworthy wrote it - and this script starts what the manifest names, with database credentials in its environment |

**The key checked is the one the application resolves**, not whichever variable happens to be
set: `crypto.ts` reads `OCTOPUS_DATA_KEY` and falls back to `sha256(BETTER_AUTH_SECRET)`, so
checking a single variable answers the wrong question.

**The env file is parsed, never sourced.** It can be `secrets.env` out of an archive, and
sourcing an archive lets an archive run commands.

### Measured on the deployment, 2026-08-26

A round trip with seeded data: one organization row and one 8-dimension collection holding
two points, backed up and restored into a disposable project, all three matching the
manifest exactly.

Negative paths exercised, each exiting non-zero with the diagnostic naming the cause: a
wrong `OCTOPUS_DATA_KEY`, a wrong `BETTER_AUTH_SECRET`, an absent key, a one-byte-longer
dump, and a manifest doctored to name `evil.example.com/pg:latest` as the PostgreSQL image.

The seeded row and probe collection were removed afterwards; the live deployment ended
healthy on all four services.

**Backups refuse to run while reviews are in flight.** The dump, the snapshot and the row
counts are three separate reads, and they only describe one state if nothing is writing.
Pause admission first (`docker compose stop ingress`, see R-0004), or pass `--allow-live` to
accept an archive whose three reads may disagree.

## Two upstream problems this works around

**The Qdrant healthcheck cannot pass.** Upstream's check shells out to `wget`, and the
`qdrant/qdrant:v1.17.0` image contains neither `wget` nor `curl`. Since `web` waits on
`qdrant: service_healthy`, upstream's own self-host compose never starts. This uses `bash`
and `/dev/tcp` to speak HTTP directly and assert a 200 from `/readyz` -- a real readiness
check rather than a port probe, so it does not report ready while collections are still
loading.

**Migrations alone cannot build a fresh database.** There is no baseline in
`packages/db/prisma/migrations`: 35 migrations carry 10 `CREATE TABLE` statements between
them, and the earliest alters `review_issues`, which nothing creates. `BASELINE=1` pushes
the schema from `schema.prisma`, then records every existing migration as applied, so a
later `migrate deploy` runs only what is genuinely new. Without that, the first migration
fails and leaves a `P3009` marker that blocks every retry.

## Migrations run inside the network

`migrate.sh` joins a throwaway container to the compose network with the schema mounted
read-only. That is not incidental: the runtime image carries no migrations and the database
publishes no port, so there is nothing on the host to connect to. Nothing is installed on
the host and nothing is left behind.

## Registering the GitHub App

```sh
./configure-github-app.sh --app-id 4717565 --slug companion-afterbrew \
  --client-id Iv23... --key ~/companion/secrets/github-app.pem
```

**The `GITHUB_APP_*` environment variables cannot work on a prebuilt image**, and the way
they fail is worth knowing because nothing says it out loud. `github-app-config.ts` reads the
slug from `NEXT_PUBLIC_GITHUB_APP_SLUG`, and Next.js inlines every `NEXT_PUBLIC_*` reference
**at build time, in server code too**. Setting it at runtime looks exactly like configuration
and changes nothing.

The symptom is not an error. It is a dashboard whose GitHub card has no *Connect* button -
the button renders only when a slug is present - while `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` sit plainly in the container's environment. `/api/github/install`
redirects to `?error=github_app_not_configured`, which is the fastest way to tell that state
apart from "not signed in".

So the App is registered in the **database**, which is where the product's own manifest flow
puts it and which takes precedence over the environment. The script writes the same columns,
encrypts the private key exactly as `crypto.ts` does, and refuses rather than overwrites when
an App is already configured.

Afterwards, the App's own **Setup URL** must point back at the deployment:

```
http://localhost:43300/api/github/callback
```

with *Redirect on update* enabled. Without it GitHub has nowhere to send the installation, and
the connect flow ends on GitHub rather than back in the dashboard.

## Signing in

The self-host image serves the marketing site and the application from one origin, so `/` is
the product's own landing page rather than a sign of a misconfigured deployment. Sign-in is
at **`/login`**.

**Use "Create an account" with a password, not the magic link.** Email/password is enabled
because the image bakes `NEXT_PUBLIC_OCTOPUS_SELF_HOSTED=true`, and sign-up signs you straight
in. The magic link needs `EMAIL_HOST` / `EMAIL_USER` / `EMAIL_PASSWORD`, which this deployment
does not set - so it would accept the request and deliver nothing. Minimum password length is
10.

The OAuth buttons read *"not configured"* for the same reason: Google, GitHub and Microsoft
sign-in each need their own client id and secret. Note that these are **sign-in** credentials,
separate from the GitHub App credentials the reviewer uses - configuring one does not configure
the other.

## Model provider slots

Octopus reaches non-first-party models through two OpenAI-compatible gateway slots,
`acp` and `opencode`. Each takes an origin and a bearer token from the environment
(`ACP_BASE_URL`/`ACP_API_KEY`, `OPENCODE_BASE_URL`/`OPENCODE_API_KEY`), or from
per-organization settings that override them. Model ids are namespaced: `acp:<model>`.

**The slot forces `/v1`.** `openai-gateway.ts` builds `<origin>/v1/chat/completions`, and
`validateProviderUrl` normalizes the configured value to an **origin**, discarding any
path. So a provider is usable through these slots only if its API lives at `/v1` on its own
host.

| Slot | Provider | Origin | Models |
|---|---|---|---|
| `acp` | MiniMax | `https://api.minimax.io` | `MiniMax-M3`, `M2.7`, `M2.5`, `M2` |
| `opencode` | DeepSeek | `https://api.deepseek.com` | `deepseek-v4-flash`, `deepseek-v4-pro` |

Both verified with a **real completion through the exact URL the slot builds**, not just a
`/models` call. DeepSeek's ceiling is the account balance itself - $5.00 topped up, nothing
granted - so the cap is arithmetic rather than a setting that can be misread.

**Z.AI does not fit, and there is no third slot.** Its API is at
`/api/paas/v4/chat/completions`; the forced `/v1` and the origin-stripping between them make
that unreachable whatever origin is configured, and `https://api.z.ai/v1` is a 404. Even if
the path worked, `acp` and `opencode` are the only two generic slots and both are taken.
Tracked in rayf#142.

Selecting which model a repository reviews with is per-organization, in the dashboard.

## Rotating secrets, and which one encrypts the data

`generate-secrets.sh` refuses to overwrite an existing `.env`. The PostgreSQL password is
fixed at initdb time, so regenerating it locks the deployment out of its own volume.
`--rotate-app` replaces `BETTER_AUTH_SECRET` and preserves everything else, including any
provider keys and OAuth settings you added by hand.

**`OCTOPUS_DATA_KEY` is the key that encrypts stored credentials.** `apps/web/lib/crypto.ts`
uses it, and falls back to `sha256(BETTER_AUTH_SECRET)` when it is unset. That fallback is
the trap: without a data key, "rotating the app secret" *is* rotating the encryption key, and
every encrypted row becomes unreadable. So this script generates a data key up front and
carries it across every rotation, and `--rotate-app` **refuses** on an `.env` that has none.

Adding one to a deployment that was provisioned without it, with nothing to re-encrypt:

```sh
# The key the fallback is already using, written down explicitly. Existing
# ciphertext stays readable byte for byte, and the secret is never printed.
set -a; . ./.env; set +a
printf 'OCTOPUS_DATA_KEY=%s\n' \
  "$(printf '%s' "$BETTER_AUTH_SECRET" | sha256sum | cut -d' ' -f1)" >> .env
docker compose up -d --force-recreate web
```

