# Meridian backend: trading agent + MCP tool server + fleet deployer.
# One long-running process; needs env secrets at runtime (see DEPLOY.md).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY skills ./skills
# Durable state (position, reservations, x402 replay ledger) goes wherever
# MERIDIAN_DATA_DIR points — in production that's a mounted volume (/data,
# see fly.toml), never the ephemeral machine filesystem.
EXPOSE 8787
CMD ["node", "dist/index.js"]
