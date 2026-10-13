# Build context is the repository root (Railway uploads the whole repo).
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/migrations ./migrations
COPY backend/src ./src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
