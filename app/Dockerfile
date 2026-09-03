# syntax=docker/dockerfile:1
# Multi-stage build for the FBYT app. The `runner` stage is the lean standalone Next server; the
# `indexer` stage keeps the full source + tsx so it can run scripts/indexer.ts. Node 24 ships node:sqlite.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* are inlined at build time; override with --build-arg for a real cluster.
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_WALLET_CHAIN
ARG NEXT_PUBLIC_CLUSTER
ARG NEXT_PUBLIC_FBYT_PROGRAM_ID
RUN pnpm build

# --- app: lean standalone server ---
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
ENV PORT=3000
ENV FBYT_DB_PATH=/data/fbyt.db
RUN mkdir -p /data && chown -R node:node /data
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# --- indexer: runs the NAV/trade snapshotter against the app ---
FROM builder AS indexer
ENV NODE_ENV=production
ENV NODE_NO_WARNINGS=1
ENV FBYT_DB_PATH=/data/fbyt.db
USER node
CMD ["node", "--import", "tsx", "scripts/indexer.ts"]
