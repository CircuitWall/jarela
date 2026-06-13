# syntax=docker/dockerfile:1.7

# Jarela — containerized build for Ubuntu/Debian-based hosts.
#
# Two-stage build:
#   1. builder   — installs dev+prod deps, runs `next build` to produce
#                  the standalone tree at .next/standalone (see next.config.ts).
#   2. runner    — slim runtime image with only the standalone bundle and
#                  prod node_modules subset Next traced. Runs as a non-root
#                  user. Persists state under /data (mount a volume there).
#
# Build:   docker build -t jarela .
# Run:     docker run --rm -p 4312:4312 -v jarela-data:/data jarela
# Open:    http://127.0.0.1:4312
#
# Notes:
# - HOSTNAME defaults to 0.0.0.0 inside the container so the port is
#   reachable from the host. On bare metal we default to 127.0.0.1.
# - JARELA_DB_DIR=/data — all SQLite + secrets + uploads live there.
# - We use node:22-bookworm-slim (Debian). Keytar's native binding builds
#   fine there; at runtime there's no D-Bus / libsecret session, so
#   master-key.ts transparently falls back to a 0600 keyfile under /data
#   (see lib/crypto/master-key.ts). That's the documented headless path.

ARG NODE_VERSION=22

# ---------- builder ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder

# Toolchain for native modules (keytar, better-sqlite3 transitive deps).
# libsecret-1-dev lets `npm install` finish keytar's gyp build cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ pkg-config libsecret-1-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Force the public npm registry regardless of any inherited host config.
# Belt-and-braces with the committed .npmrc: even if a contributor builds
# from a checkout where .npmrc was stomped on, the image build still
# resolves packages from registry.npmjs.org.
ENV NPM_CONFIG_REGISTRY=https://registry.npmjs.org/ \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# Install deps first for better layer caching. We also need every workspace's
# package.json on disk before `npm ci` because the root lockfile resolves the
# @circuitwall/*-langchain entries via the `workspace:` protocol — npm reads
# each sub-package's manifest to materialize the symlinks under node_modules.
COPY package.json package-lock.json* ./
COPY packages/atlassian-langchain/package.json   ./packages/atlassian-langchain/
COPY packages/github-langchain/package.json      ./packages/github-langchain/
COPY packages/jira-align-langchain/package.json  ./packages/jira-align-langchain/
RUN npm ci --no-audit --no-fund --registry=https://registry.npmjs.org/

# Copy the rest of the sources and build the standalone bundle.
COPY . .
RUN npm run build

# ---------- runner ----------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

# libsecret-1-0 is only needed if you want keytar to *try* the keychain.
# It will fail (no D-Bus session) and fall back to the keyfile anyway,
# so we skip it to keep the image small. The keyfile path is supported
# and documented.

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4312 \
    HOSTNAME=0.0.0.0 \
    JARELA_DB_DIR=/data

# Copy the self-contained Next standalone tree produced by the builder.
# postbuild.mjs already hydrated public/ and .next/static/ inside it.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Non-root user owns the data dir so the keyfile / sqlite can be written.
RUN mkdir -p /data \
 && chown -R node:node /app /data

USER node
VOLUME ["/data"]
EXPOSE 4312

# Lightweight TCP healthcheck (no curl/wget in the slim image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('node:net').createConnection({host:'127.0.0.1',port:Number(process.env.PORT)||4312}).on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
