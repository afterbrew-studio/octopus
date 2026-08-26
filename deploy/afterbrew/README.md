# The afterbrew Octopus deployment

Upstream's `docker-compose.selfhost.yml` is not used directly. This directory is the
deployment rayf's P-0007 describes, and every difference from upstream is deliberate.

## Deploy

```sh
./generate-secrets.sh                 # writes .env, mode 600, never prints a value
docker compose up -d
BASELINE=1 ./migrate.sh ./prisma      # first time only
```

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
refused there with `401 Invalid signature`; 18 other routes -- the dashboard, `/api/health`,
`/api/admin/*`, `/api/cli/*`, `/api/agent/*`, the other providers' webhooks, and the webhook
path under the wrong method -- are refused at the edge; and no datastore answers on a host
port.

A denied route has to be **404 with an empty body**. Status alone would not do: Next.js
also answers 404, with an HTML page, so a status-only check passes just as happily when the
request reached the application and the allowlist did not hold.

Measured on the deployment, 2026-08-26: 26 checks, 26 passed.

### What is not here yet

No tunnel. Choosing one and naming it publicly is an operator decision -- it needs an
account and a domain -- and it is deliberately the last step: the boundary should be
provable before anything from outside can reach it, not after. Whatever tunnel is chosen
points at `127.0.0.1:${OCTOPUS_INGRESS_PORT:-43310}` and nothing else, and `probe-ingress.sh`
should be re-run through the public name once it exists, because a probe against loopback
proves the allowlist and not the tunnel's own routing.

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

## Rotating secrets

`generate-secrets.sh` refuses to overwrite an existing `.env`. The PostgreSQL password is
fixed at initdb time, so regenerating it locks the deployment out of its own volume. Use
`--rotate-app` for the application secrets, which are safe to change.
