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

## Setup

```bash
npm install
```

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

## Scripts

| Command              | Description              |
|----------------------|--------------------------|
| `npm run dev`        | Start with tsx watch     |
| `npm run build`      | Compile TypeScript       |
| `npm start`          | Run compiled `dist/`     |
| `npm run lint`       | Run ESLint               |
| `npm test`           | Run tests                |
| `npm run test:coverage` | Run tests with coverage |

## API (current)

| Method | Path                    | Description            |
|--------|-------------------------|------------------------|
| GET    | `/api/health`           | Health check           |
| GET    | `/api/trust/:address`   | Trust score            |
| GET    | `/api/bond/:address`    | Bond status (stub)     |

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

## Tech

- Node.js
- TypeScript
- Express

Extend with PostgreSQL, Redis, and Horizon event ingestion when implementing the full architecture.
