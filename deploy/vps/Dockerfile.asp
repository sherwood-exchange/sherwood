# Sherwood ASP auto-approver. Build context = repo root.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY client ./client
COPY asp ./asp

ENV NODE_ENV=production
EXPOSE 8792
# Config (POOL_ADDRESS, RPC_URL, CHAIN_ID, POINTS_FROM_BLOCK, ASP_PRIVATE_KEY) from env.
CMD ["npx", "tsx", "asp/src/approver.ts"]
