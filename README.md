# Credence Backend

API and services for the Credence economic trust protocol. Provides health checks, trust score and bond status endpoints (to be wired to Horizon and a reputation engine).

## About

This service is part of [Credence](../README.md). It will support:

- Public query API (trust score, bond status, attestations)
- **Horizon listener / identity state sync** – Reconciles DB with on-chain bond state (see [Identity state sync](#identity-state-sync)).
- Reputation engine (off-chain score from bond data) (future)

## Prerequisites

- Node.js 18+
- npm or pnpm
- Redis server (for caching)
- Docker & Docker Compose (for containerised dev)

## Setup

```bash
npm install
# Set Redis URL in environment
export REDIS_URL=redis://localhost:6379
cp .env.example .env
# Edit .env with your actual values
```

The server **fails fast** on startup if any required environment variable is missing or invalid. See [Environment Variables](#environment-variables) below.

## Run locally

**Development (watch mode):**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm start
```

API runs at [http://localhost:3000](http://localhost:3000). The frontend proxies `/api` to this URL.

---

## Docker (recommended for local dev)

The project ships with **Dockerfile**, **docker-compose.yml**, and an example env file so you can spin up the full stack (API + PostgreSQL + Redis) in one command.

### Quick start

```bash
# 1. Create your local env file
cp .env.example .env

# 2. Build and start all services
docker compose up --build

# 3. Verify health
curl http://localhost:3000/api/health
# → {"status":"ok","service":"credence-backend"}
```

### Services

| Service    | Port  | Description                  |
|------------|-------|------------------------------|
| `backend`  | 3000  | Express / TypeScript API     |
| `postgres` | 5432  | PostgreSQL 16                |
| `redis`    | 6379  | Redis 7                     |

All ports are configurable via `.env` (see `.env.example`).

### Seeding the database

Drop any `.sql` files into the `init-db/` directory. PostgreSQL will execute them **once** when the data volume is first created. A placeholder file (`init-db/001_schema.sql`) is included as a starting point.

To re-run init scripts, remove the volume and restart:

```bash
docker compose down -v   # removes data volumes
docker compose up --build
```

### Useful commands

```bash
# Stop all services
docker compose down

# Stop and remove volumes (reset DB/Redis data)
docker compose down -v

# View logs
docker compose logs -f backend

# Rebuild only the backend image
docker compose build backend

# Open a psql shell
docker compose exec postgres psql -U credence
```

### Environment variables

All configuration is driven by environment variables. Copy `.env.example` to `.env` and adjust as needed. Key variables:

| Variable            | Default     | Description                |
|---------------------|-------------|----------------------------|
| `PORT`              | `3000`      | Backend listen port        |
| `POSTGRES_USER`     | `credence`  | PostgreSQL user            |
| `POSTGRES_PASSWORD` | `credence`  | PostgreSQL password        |
| `POSTGRES_DB`       | `credence`  | PostgreSQL database name   |
| `POSTGRES_PORT`     | `5432`      | Host-exposed PG port       |
| `REDIS_PORT`        | `6379`      | Host-exposed Redis port    |
| `DATABASE_URL`      | (composed)  | Full PG connection string  |
| `REDIS_URL`         | (composed)  | Full Redis connection URL  |

---

## Scripts

| Command                 | Description              |
|-------------------------|---------------------------|
| `npm run dev`           | Start with tsx watch     |
| `npm run build`         | Compile TypeScript       |
| `npm start`             | Run compiled `dist/`     |
| `npm run lint`          | Run ESLint               |
| `npm test`              | Run tests                |
| `npm run test:watch`    | Run tests in watch mode  |
| `npm run test:coverage` | Run tests with coverage  |
| Command              | Description                  |
|----------------------|------------------------------|
| `npm run dev`        | Start with tsx watch         |
| `npm run build`      | Compile TypeScript           |
| `npm start`          | Run compiled `dist/`         |
| `npm run lint`       | Run ESLint                   |
| `npm test`           | Run tests (vitest)           |
| `npm run test:watch` | Run tests in watch mode      |
| `npm run test:coverage` | Run tests with coverage   |
| Command              | Description              |
|----------------------|--------------------------|
| `npm run dev`        | Start with tsx watch     |
| `npm run build`      | Compile TypeScript       |
| `npm start`          | Run compiled `dist/`     |
| `npm run lint`       | Run ESLint               |
| `npm run test`       | Run tests                |
| `npm test`           | Run test suite           |
| `npm run test:coverage` | Run tests with coverage |

## API (current)

| Method | Path               | Description        |
|--------|--------------------|--------------------|
| GET    | `/api/health`      | Health check       |
| GET    | `/api/health/cache` | Redis cache health check |
| GET    | `/api/trust/:address` | Trust score (stub) |
| GET    | `/api/bond/:address`   | Bond status (stub) |
| Method | Path                    | Description            |
|--------|-------------------------|------------------------|
| Method | Path                         | Description              |
|--------|------------------------------|---------------------------|
| GET    | `/api/health`           | Health check           |
| GET    | `/api/trust/:address`   | Trust score            |
| GET    | `/api/bond/:address`    | Bond status (stub)     |
| GET    | `/api/attestations/:address` | List attestations |
| POST   | `/api/attestations`      | Create attestation     |

Invalid input returns **400** with `{ "error": "Validation failed", "details": [{ "path", "message" }] }`. See [docs/VALIDATION.md](docs/VALIDATION.md).
| GET    | `/api/attestations/:address` | Attestations (stub)      |
| GET    | `/api/verification/:address` | Verification proof (stub)|

Full request/response documentation, cURL examples, and import instructions:
**[docs/api.md](docs/api.md)**

### OpenAPI spec

```
docs/openapi.yaml
```

Render with `npx @redocly/cli preview-docs docs/openapi.yaml` or paste into [editor.swagger.io](https://editor.swagger.io).

### Postman / Insomnia collection

```
docs/credence.postman_collection.json
```

Import via **File → Import** in Postman or Insomnia. See [docs/api.md](docs/api.md#importing-the-postman-collection) for step-by-step instructions and Newman CLI usage.

### Health endpoint (detailed)

The health API reports status per dependency (database, Redis, optional external) without exposing internal details.

- **Readiness** (`GET /api/health` or `GET /api/health/ready`): Returns `200` when all *configured* critical dependencies (DB, Redis) are up; returns `503` if any critical dependency is down. When `DATABASE_URL` or `REDIS_URL` are not set, those dependencies are reported as `not_configured` and do not cause `503`.
- **Liveness** (`GET /api/health/live`): Returns `200` when the process is running (no dependency checks). Use for Kubernetes/orchestrator liveness probes.

Response shape (readiness):

```json
{
  "status": "ok",
  "service": "credence-backend",
  "dependencies": {
    "db": { "status": "up" },
    "redis": { "status": "up" }
  }
}
```

`status` may be `ok`, `degraded` (optional external down), or `unhealthy` (critical dependency down). Each dependency `status` is `up`, `down`, or `not_configured`. Optional env: `DATABASE_URL`, `REDIS_URL` to enable DB and Redis checks.

### Testing

Health endpoints are covered by unit and route tests. Run:

```bash
npm test
npm run test:coverage
```

Scenarios covered: all dependencies up, DB down (503), Redis down (503), both down (503), only external down (200 degraded), liveness always 200, and no dependencies configured (200 ok).

### Identity state sync

The **identity state sync** listener keeps database identity and bond state in sync with on-chain state (reconciliation or full refresh). Use it to correct drift from missed events or for recovery.

- **Location:** `src/listeners/identityStateSync.ts`
- **Reconciliation by address:** `sync.reconcileByAddress(address)` – fetches current state from the contract, diffs with DB, and updates the store if there is drift.
- **Full resync:** `sync.fullResync()` – reconciles all known identities (union of store and contract addresses). Use for recovery or bootstrap.

You supply:

- **ContractReader** – Fetches current bond/identity state from chain (e.g. Horizon or contract reads). Implement `getIdentityState(address)` and optionally `getAllIdentityAddresses()`.
- **IdentityStateStore** – Your persistence layer (e.g. DB). Implement `get`, `set`, and `getAllAddresses`.

State shape is `IdentityState`: `address`, `bondedAmount`, `bondStart`, `bondDuration`, `active`. See `src/listeners/types.ts`.

Tests cover: no drift (no update), single drift (one address corrected), full resync (multiple drifts), chain missing, store-only addresses, and error handling.

## Caching

The service includes a Redis-based caching layer with:

- **Connection management** - Singleton Redis client with health monitoring
- **Namespacing** - Automatic key namespacing (e.g., `trust:score:0x123`)
- **TTL support** - Set expiration times on cached values
- **Health checks** - Built-in Redis health monitoring
- **Graceful fallback** - Continues working when Redis is unavailable

See [docs/caching.md](./docs/caching.md) for detailed documentation.
## Developer SDK

A TypeScript/JavaScript SDK is available at `src/sdk/` for programmatic access to the API. See [docs/sdk.md](docs/sdk.md) for full documentation.
## Configuration

The config module (`src/config/index.ts`) centralizes all environment handling:

- Loads `.env` files via [dotenv](https://github.com/motdotla/dotenv) for local development
- Validates **all** environment variables at startup using [Zod](https://zod.dev)
- Fails fast with a clear error message listing every invalid or missing variable
- Exports a fully typed `Config` object consumed by the rest of the application

### Usage

```ts
import { loadConfig } from './config/index.js'

const config = loadConfig()
console.log(config.port)          // number
console.log(config.db.url)        // string
console.log(config.features)      // { trustScoring: boolean, bondEvents: boolean }
```

For testing, use `validateConfig()` which throws a `ConfigValidationError` instead of calling `process.exit`:

```ts
import { validateConfig, ConfigValidationError } from './config/index.js'

try {
  const config = validateConfig({ DB_URL: 'bad' })
} catch (err) {
  if (err instanceof ConfigValidationError) {
    console.error(err.issues) // Zod issues array
  }
}
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | Server port (1–65535) |
| `NODE_ENV` | No | `development` | `development`, `production`, or `test` |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `DB_URL` | **Yes** | — | PostgreSQL connection URL |
| `REDIS_URL` | **Yes** | — | Redis connection URL |
| `JWT_SECRET` | **Yes** | — | JWT signing secret (≥ 32 chars) |
| `JWT_EXPIRY` | No | `1h` | JWT token lifetime |
| `ENABLE_TRUST_SCORING` | No | `false` | Enable trust scoring feature |
| `ENABLE_BOND_EVENTS` | No | `false` | Enable bond event processing |
| `HORIZON_URL` | No | — | Stellar Horizon API URL |
| `CORS_ORIGIN` | No | `*` | Allowed CORS origin |

## Tech

- Node.js
- TypeScript
- Express
- Zod (request validation)
- Redis (caching layer)
- Vitest (testing)
- Zod (env validation)
- dotenv (.env file support)
- Vitest (testing)

## Stellar/Soroban Integration

- Adapter implementation: `src/clients/soroban.ts`
- Integration notes: `docs/stellar-integration.md`
- Tests: `src/clients/soroban.test.ts`

Extend with PostgreSQL, Redis, and Horizon event ingestion when implementing the full architecture.

## Integration tests

Repository integration tests are under `tests/integration/` and execute against real PostgreSQL.

- Use Docker/Testcontainers automatically: `npm run test:integration`
- Use an existing DB in CI: `TEST_DATABASE_URL=postgresql://... npm run test:integration`
- Coverage report: `npm run coverage`
Extend with PostgreSQL and Horizon event ingestion when implementing the full architecture.
