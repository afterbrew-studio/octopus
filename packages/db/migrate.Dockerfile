# One-shot migration image. Build from the repo root:
#   docker build -f packages/db/migrate.Dockerfile .
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

RUN mkdir /work && chown node:node /work
USER node
WORKDIR /work

# Installed into /work so the generated config resolves `prisma/config`. Versions match bun.lock.
RUN npm init -y >/dev/null \
 && npm install --no-audit --no-fund prisma@7.5.0 pg@8.20.0

COPY --chown=node:node packages/db/prisma/schema.prisma prisma/schema.prisma
COPY --chown=node:node packages/db/prisma/migrations prisma/migrations
COPY --chown=node:node packages/db/migrate-entrypoint.sh migrate-entrypoint.sh

ENTRYPOINT ["sh", "/work/migrate-entrypoint.sh"]
