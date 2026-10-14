# --- build: install everything, generate Prisma client, compile TS ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build && npm prune --omit=dev

# --- runtime: compiled JS + prod deps only, non-root ---
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1
# Apply pending migrations, then start. migrate deploy never resets data.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
