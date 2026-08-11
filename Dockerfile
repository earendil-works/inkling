FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    INKLING_DATA_DIR=/data \
    PORT=8787

RUN corepack enable && useradd --create-home --uid 10001 inkling
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json theme.schema.json .npmrc ./
COPY themes ./themes
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
      --filter @earendil-works/inkling-cli... \
      --filter @earendil-works/inkling-frontend \
    && pnpm --filter @earendil-works/inkling-frontend run build

RUN mkdir -p /data && chown -R inkling:inkling /app /data
USER inkling
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/cli/src/main.ts", "serve"]
