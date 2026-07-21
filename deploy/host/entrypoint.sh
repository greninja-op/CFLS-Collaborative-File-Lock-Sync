#!/bin/sh
set -eu

: "${CFLS_TEAM_ID:?CFLS_TEAM_ID is required}"
: "${CFLS_REPO_ID:?CFLS_REPO_ID is required}"
: "${CFLS_BRANCH:?CFLS_BRANCH is required}"
: "${CFLS_BIND_URL:?CFLS_BIND_URL is required}"
: "${CFLS_DB_PATH:?CFLS_DB_PATH is required}"

mkdir -p "$HOME/.cfls" "$(dirname "$CFLS_DB_PATH")" /app/.coordination

# Docker build contexts intentionally exclude .git and runtime credentials.
# Supply the same stable repository session through the supported manual
# session fallback instead of baking git metadata or secrets into the image.
node /app/deploy/host/write-session.mjs

if [ ! -s "$HOME/.cfls/host.json" ]; then
  echo "[cfls-host] Initializing persistent admin identity for team $CFLS_TEAM_ID"
  node /app/apps/cli/dist/index.js admin-init --team "$CFLS_TEAM_ID"
fi

exec node /app/apps/cli/dist/index.js host \
  --url "$CFLS_BIND_URL" \
  --db "$CFLS_DB_PATH"
