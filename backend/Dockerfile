# Build context is the repo root (frontend + backend). One image runs both the API and the worker:
#   API:    default CMD
#   worker: node dist/worker.js

# --- frontend: built once, served same-origin by the API ---
FROM node:24-alpine AS web
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# --- build: install everything, generate Prisma client, compile TS ---
FROM node:24-alpine AS build
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# --- runtime: compiled JS + prod deps only, non-root ---
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json ./
# server.ts looks for ../../frontend/dist relative to dist/server.js
COPY --from=web /frontend/dist /frontend/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health/ready || exit 1
# Apply pending migrations, then start. migrate deploy never resets data.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
