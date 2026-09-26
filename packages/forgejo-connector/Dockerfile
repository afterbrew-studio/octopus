FROM --platform=$BUILDPLATFORM oven/bun:1.3.4-alpine AS build
WORKDIR /app
COPY packages/forgejo-connector/src ./src
RUN bun build ./src/runner.ts --target=node --outfile=/app/runner.mjs

# Use the same Node HTTPS implementation as the Octopus server. Older Bun
# runtimes validate pinned connections against the IP instead of the hostname.
FROM node:22-alpine
WORKDIR /app
COPY --from=build --chown=node:node /app/runner.mjs ./runner.mjs
USER node
ENV NODE_ENV=production
CMD ["node", "runner.mjs"]
