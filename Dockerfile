FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    JOT_DATA_DIR=/data \
    PORT=8787

RUN corepack enable && useradd --create-home --uid 10001 jot
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile \
      --filter @earendil-works/jot-cli... \
      --filter @earendil-works/jot-frontend \
    && pnpm --filter @earendil-works/jot-frontend run build

RUN mkdir -p /data && chown -R jot:jot /app /data
USER jot
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/cli/src/main.ts", "serve"]
