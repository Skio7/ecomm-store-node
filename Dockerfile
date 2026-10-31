# Production image. Build context = repo root:  docker build -t store-service .
FROM node:22-alpine
ENV NODE_ENV=production     PORT=4001
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 4001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "src/index.js"]
