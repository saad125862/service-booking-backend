# Same image runs locally (docker compose) and on Render.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Generate the Prisma client at build time (needs no database connection).
COPY prisma ./prisma
COPY prisma.config.js ./
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
COPY docs ./docs
COPY src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
