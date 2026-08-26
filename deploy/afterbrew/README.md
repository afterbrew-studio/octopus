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
a signature-verified webhook route publicly, which is separate ingress this file does not
create.

**No credential has a default.** Upstream ships `octopus:octopus`. `${VAR:?}` here means
compose refuses to start when a variable is unset rather than quietly using a known
password.

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

## Reaching it: a public hostname behind Cloudflare Access

The dashboard is not published to the internet by the compose file, and it is not meant to be
reached over an SSH tunnel either. A tunnel makes the whole deployment depend on one
workstation, and `BETTER_AUTH_URL` is not a convenience setting - cookies, redirects and the
OAuth `redirect_uri` all derive from it, so a `localhost` value bakes "only a browser with a
tunnel open can complete an auth flow" into permanent configuration, including the GitHub
App's own callback URL.

So it is published through an existing Cloudflare tunnel, with Access in front:

| | |
|---|---|
| Hostname | `octopus.afterbrew.studio` |
| Tunnel route | `HTTP` → `web:3000` |
| Access policy | Allow, by email |

`web:3000` and not a host port: the connector container is joined to this deployment's compose
network, so it reaches the service by name. The published ports stay bound to loopback - sharing
a network is what makes the service reachable without widening that publication. That join must
be declared in the connector's own compose file, or it disappears the next time that stack is
recreated.

`BETTER_AUTH_URL` is then the public origin. It is a **one-way switch**: `trustedOrigins` is
exactly `[BETTER_AUTH_URL]`, so loopback sign-in stops working the moment it changes. The
loopback publication stays anyway, because diagnosing from the host is easier without a
browser.

What Access is doing here is the whole security control - the ingress allowlist fronts a
different path and is not in this one. Verified by an unauthenticated request:

```
$ curl -I https://octopus.afterbrew.studio/login
HTTP/2 302
location: https://<team>.cloudflareaccess.com/cdn-cgi/access/login/octopus.afterbrew.studio
```

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

### What the App itself must be set to

Three settings on the App, none of which this deployment can set for you. Without them the
connect flow ends on GitHub rather than back in the dashboard.

| Setting | Value | Why |
|---|---|---|
| **Callback URL** | `http://localhost:43300/api/github/callback` | used as the OAuth `redirect_uri` when the callback verifies you can access the installation |
| **Setup URL** + *Redirect on update* | the same URL | where GitHub sends you after an install or a configure-and-save. Without *Redirect on update*, an App that is **already installed** opens its configure page and never comes back |
| **Client secret** | generate one | `/api/github/callback` refuses with `github_verification_not_configured` unless both a client id and a client **secret** are stored |

The client secret is not the App's private key and not its client id - it is a third
credential, generated on the App settings page. Store it with:

```sh
./configure-github-app.sh --update --client-secret <secret>
```

`--update` touches only the secret columns, so it cannot quietly repoint the deployment at a
different App.

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

## Embeddings run locally

The review path is not optional about embeddings: `reviewer.ts` awaits `indexRepository`
and a retrieval `createEmbeddings` with **no diff-only fallback**, so a deployment without an
embedding provider does not produce a worse review - it throws, and the pull request is marked
failed.

Neither of the wired chat providers helps. The gateway slot speaks
`/v1/chat/completions` and nothing else, and DeepSeek publishes no embeddings API at all. So
`ollama` runs in this stack with `nomic-embed-text`: no API key, no per-token cost, and no
private repository content leaving the host to be embedded by a third vendor.

```
provider=ollama  model=nomic-embed-text  dim=768  url=http://ollama:11434
```

### The dimension is a one-way door

Qdrant collections are created with a fixed vector size, and vectors from different models are
not comparable. Changing the embedding model after the first index means wiping the collections
and re-indexing - it is not a settings change.

This is not hypothetical. The application creates `code_chunks` from whatever
`getEmbedConfig().dim` says at the time, and on this deployment it had already done so at
**3072**, the OpenAI default, before any of this was configured. Left alone, the first index
would have written 768-dim vectors into a 3072-dim collection, and Qdrant would have rejected
the upsert with a 400 well after anyone would connect it to the embedding setting.

It was empty, so it was dropped and is recreated lazily at 768 on the first index. **Check the
collection's size before the first review, not after:**

```sh
docker compose exec -T qdrant bash -c \
  'exec 3<>/dev/tcp/127.0.0.1/6333; printf "GET /collections/code_chunks HTTP/1.0\r\n\r\n" >&3; cat <&3'
```

`backup.sh` records the size and `restore.sh` refuses on a mismatch, for the same reason.

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

