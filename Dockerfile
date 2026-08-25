FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
# Lockfiles are gitignored repo-wide, so install (not `npm ci`) to build
# reliably from a fresh checkout.
RUN npm install --legacy-peer-deps --no-audit --no-fund

COPY src/ ./src/
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
ARG GIT_SHA=unknown
FROM node:22-alpine
ENV GIT_SHA=$GIT_SHA

WORKDIR /app

COPY package*.json ./
# Lockfiles are gitignored repo-wide, so install (not `npm ci`) to build
# reliably from a fresh checkout.
RUN npm install --legacy-peer-deps --omit=dev --no-audit --no-fund

COPY --from=builder /app/dist ./dist
# Vertical definitions (tools, schema, seed). The active one is chosen by
# VERTICAL at runtime; its seed is applied at startup only when the tables in
# /app/data/<VERTICAL>.db are empty, so a restart never clobbers edits.
COPY verticals/ ./verticals/

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/health || exit 1

CMD ["node", "--experimental-sqlite", "dist/index.js"]
