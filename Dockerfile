FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 POS_DATA_DIR=/var/lib/mansu-pos
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
# The authenticated physical-store catalogue verifies the original files and
# reviewed snapshot at runtime, even when cash checkout is locked. Never copy
# these source documents into dist (the public web root).
COPY --chown=node:node products.csv Stock-2026-11-12.pdf ./
COPY --chown=node:node data/instore-stock-snapshot.json ./data/
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/mansu-pos && chown node:node /var/lib/mansu-pos && chmod 0700 /var/lib/mansu-pos
USER node
EXPOSE 3000
VOLUME ["/var/lib/mansu-pos"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
