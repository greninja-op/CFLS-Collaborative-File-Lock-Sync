# syntax=docker/dockerfile:1

# The host is built inside Docker so an ARM64/AMD64 server only needs Docker;
# it does not need a pre-installed Node or pnpm toolchain.
FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.13.1 --activate

COPY . .

RUN pnpm install --frozen-lockfile \
  && pnpm -r run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# The normal CLI build uses workspace package symlinks, so retain the built
# workspace and its installed dependencies from the build stage.
COPY --from=build /app /app

ENV NODE_ENV=production \
    HOME=/var/lib/cfls

COPY deploy/host/entrypoint.sh /usr/local/bin/cfls-host

RUN chmod 0755 /usr/local/bin/cfls-host \
  && mkdir -p /var/lib/cfls/data

EXPOSE 8730

ENTRYPOINT ["/usr/local/bin/cfls-host"]
