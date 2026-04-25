# syntax=docker/dockerfile:1

# Stage 1: base
FROM node:24-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 build-essential ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Stage 2: deps
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/storage/package.json ./packages/storage/
COPY packages/logger/package.json ./packages/logger/
RUN pnpm install --frozen-lockfile

# Stage 3: builder
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY . .
RUN pnpm turbo run build --filter=@whis/worker...

# Stage 4: runtime
FROM base AS runtime
ENV NODE_ENV=production
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/storage/dist ./packages/storage/dist
COPY --from=builder /app/packages/storage/package.json ./packages/storage/
COPY --from=builder /app/packages/storage/node_modules ./packages/storage/node_modules
COPY --from=builder /app/packages/logger/dist ./packages/logger/dist
COPY --from=builder /app/packages/logger/package.json ./packages/logger/
COPY --from=builder /app/packages/logger/node_modules ./packages/logger/node_modules
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/apps/worker/node_modules ./apps/worker/node_modules
COPY package.json pnpm-workspace.yaml ./

RUN mkdir -p /app/data && chown -R node:node /app/data /app

USER node
ENV HOME=/home/node

# Claude Code CLI (pra setup-token + introspecção). Runtime usa o SDK.
RUN curl -fsSL https://claude.ai/install.sh | bash || true
ENV PATH="/home/node/.local/bin:${PATH}"

VOLUME ["/app/data"]

COPY --chown=node:node infra/entrypoint.sh /usr/local/bin/whis-entrypoint.sh
USER root
RUN chmod +x /usr/local/bin/whis-entrypoint.sh
USER node
ENTRYPOINT ["/usr/local/bin/whis-entrypoint.sh"]

EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
