FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    PORT=4173 \
    PUPPETEER_SKIP_DOWNLOAD=1

# Baked into the client bundle at build time (see build/vite.js `define`) — a
# browser key change requires rebuilding the image, not just restarting it.
ARG CESIUM_ION_TOKEN
ARG GOOGLE_MAPS_API_KEY
ENV CESIUM_ION_TOKEN=${CESIUM_ION_TOKEN} \
    GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Built once here so the fast path (preview) never needs a rebuild to switch
# into; the entrypoint chooses dev vs. preview at container start via
# GEV_RUN_MODE. `vite dev` transforms every module on first request, which
# pegs CPU and stalls the client during layer activation — use it only when
# you need the Provider Settings key-setup wizard.
RUN npm run build
RUN chmod +x scripts/docker-entrypoint.sh

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["scripts/docker-entrypoint.sh"]
