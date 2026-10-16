# SpendVeto — self-host image. Simulate mode by default (zero setup, real
# ECDSA, local settlement); set SPENDVETO_MODE=testnet + the wallet env vars
# for real x402 on Base Sepolia. Runs the API + dashboard on :8402.
# Node 22: Node 20 reached end-of-life in April 2026, and @x402/stellar ≥2.28
# declares node >=22.
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. Production deps only — the dev/verify
# tooling isn't needed to run the server.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# data/ holds the ledger, balances, policy, delegations — mount a volume here
# to persist across container restarts (see docker-compose.yml).
VOLUME ["/app/data"]

ENV SPENDVETO_MODE=simulate
EXPOSE 8402 8404

# Default: the governed API + dashboard. Override the command to run the proxy
# (node proxy/server.js) or both via compose.
CMD ["node", "server/index.js"]
