# Performance Baseline

> **Audience:** Contributors adding new endpoints or middleware, and operators
> tuning the service for production deployments.

---

## Baseline: 100 req/s per free-tier client

Credence Backend is configured to sustain **100 requests per 60-second window**
for free-tier clients. This is enforced by the rate-limit middleware mounted in
`src/app.ts`:

```ts
rateLimitConfig = {
  enabled: true,
  windowSec: 60,
  maxFree: 100,      // ← free-tier baseline
  maxPro: 1000,
  maxEnterprise: 10000,
  failOpen: !isProd,
};
```

Higher tiers scale linearly: Pro clients get 10× and Enterprise clients get
100× the free baseline. All limits apply per client within a sliding 60-second
window.

---

## Reproducing the baseline locally

### Prerequisites

- Node.js 18+
- Docker & Docker Compose (spins up Postgres + Redis)
- [`autocannon`](https://github.com/mcollina/autocannon) for HTTP load testing

```bash
npm install -g autocannon
```

### 1. Start the stack

```bash
cp .env.example .env
docker compose up --build -d
```

Verify the API is up:

```bash
curl http://localhost:3000/api/health
# → {"status":"ok","service":"credence-backend"}
```

### 2. Run the baseline load test

The health endpoint has no DB or Redis dependency, making it the cleanest
surface for measuring raw throughput:

```bash
autocannon -c 10 -d 30 http://localhost:3000/api/health
```

Expected output (approximate):
