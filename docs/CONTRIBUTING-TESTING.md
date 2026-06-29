# Contributor Testing Runbook

Everything you need to go from `git clone` to a green test suite.

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | 20+ | Runtime |
| pnpm | any | Package manager |
| Docker | Desktop or Engine | testcontainers and chaos suite |

---

## Environment Setup

```bash
# Install dependencies
pnpm install

# Copy the env template
cp .env.example .env
```

Edit `.env` — the required variables for local testing are `DB_URL`, `REDIS_URL`, and `JWT_SECRET`. For most test runs these are not needed because the tests provision their own databases (see [Database Backends](#database-backends) below), but the app and migration commands read from `.env`.

---

## Database Backends

The test suite supports two database backends. Which one runs depends on whether you set `TEST_DATABASE_URL`.

### pg-mem (unit tests)

Tests under `src/**/*.test.ts` and `src/**/*.spec.ts` use [pg-mem](https://github.com/oguimbal/pg-mem) — an in-memory PostgreSQL simulation. **No Docker required.** Each test file creates its own isolated in-memory database and tears it down when done.

Use pg-mem when:
- Writing unit tests for a single repository, service, or middleware
- You want instant startup and zero external dependencies
- You need to register custom functions (e.g. `gen_random_uuid`) that pg-mem doesn't support natively

Limitation: pg-mem does not implement the full PostgreSQL dialect. Tests that rely on advanced PostgreSQL features (window functions, advisory locks, certain constraint types) must use testcontainers instead.

### testcontainers (integration tests)

Tests under `tests/integration/**` and `tests/repositories/**` use [testcontainers](https://testcontainers.com/guides/getting-started-with-testcontainers-for-nodejs/) to spin up a real `postgres:16-alpine` container automatically. Docker must be running.

If `TEST_DATABASE_URL` is set, testcontainers is skipped and that connection is used instead — this is how CI passes its own managed PostgreSQL service to the test suite.

```bash
# Auto mode (testcontainers starts Docker for you)
pnpm test

# External DB mode (CI or your own local Postgres)
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test pnpm test
```

> `TEST_DATABASE_URL` must be set in `.env` (or the shell environment) when you want the integration tests to skip testcontainers and connect to an existing Postgres instance. See `.env.example` for the expected format.

---

## Bringing Up Dependencies (docker-compose)

The chaos suite and manual integration testing use `docker-compose.test.yml`, which starts three services:

| Service | Image | Host port |
|---------|-------|-----------|
| `test-db` | postgres:16-alpine | 5433 |
| `test-redis` | redis:7-alpine | 6380 |
| `test-horizon` | node:20-alpine (stub) | 8000 |

```bash
# Start all test services
docker compose -f docker-compose.test.yml up -d

# Verify they are healthy
docker compose -f docker-compose.test.yml ps

# Tear down (removes volumes)
docker compose -f docker-compose.test.yml down --volumes
```

The test-db uses `tmpfs` storage — data is not persisted across restarts, which keeps tests fast and deterministic.

---

## Running Migrations

Run migrations against a local database before integration testing or manual exploration.

```bash
# Build TypeScript, then apply all pending migrations
pnpm run migrate:dev
```

`migrate:dev` requires `DB_URL` (or `DATABASE_URL`) to be set in `.env` and Docker to be running with a database available. If you started `docker-compose.test.yml`:

```bash
DB_URL=postgresql://credence:credence@localhost:5433/credence_test pnpm run migrate:dev
```

---

## Test Commands

All commands are verified against `package.json`.

### Run all tests

```bash
pnpm test
```

Runs `vitest run` across:
- `src/**/*.test.ts` / `src/**/*.spec.ts` — unit tests (pg-mem)
- `tests/integration/**/*.test.ts` — integration tests (testcontainers)
- `tests/routes/**/*.test.ts` — route/API tests
- `monitoring/**/*.test.ts` — monitoring tests

### Watch mode (development)

```bash
pnpm run test:watch
```

Re-runs affected tests on file save. Useful during active development.

### Run a single suite or file

```bash
# Single file
pnpm test -- tests/integration/repositories.test.ts

# Directory
pnpm test -- tests/routes/

# Pattern match
pnpm test -- rbac
```

### Coverage (standard thresholds)

```bash
pnpm run test:coverage
# or equivalently:
pnpm run coverage
```

Generates an Istanbul HTML report in `coverage/`. Standard thresholds: 40% globally; 95% for `src/sdk/**`.

### Coverage (audit thresholds)

```bash
pnpm run coverage:audit
```

Uses `vitest.audit.config.ts`. Targets a focused set of high-risk files (disputes, governance, evidence routes; admin and audit services; auditLogsRepository) and enforces 20% minimum thresholds on that subset. Run this before submitting changes to those files.

### Chaos suite

```bash
# Requires docker-compose.test.yml services running
docker compose -f docker-compose.test.yml up -d
pnpm run test:chaos
```

Runs `vitest run tests/chaos --sequence`. Tests in `tests/chaos/` simulate real failure modes:

- `postgresFailover.test.ts` — database container kill/restart
- `redisAndOutboxChaos.test.ts` — Redis unavailability and outbox retry
- `horizonRecovery.test.ts` — Horizon stub returning errors and recovering

The `--sequence` flag forces sequential test execution so container restarts in one test don't interfere with another.

---

## Coverage Config Reference

| Config file | Coverage provider | Included files | Thresholds |
|-------------|-------------------|---------------|------------|
| `vitest.config.ts` | istanbul | `src/**/*.ts` (minus types, barrels, utils) | 40% global; 95% for `src/sdk/**` |
| `vitest.audit.config.ts` | v8 | Specific routes and services | 20% statements/lines |

---

## Troubleshooting

### Docker not running

```
Error: connect ENOENT /var/run/docker.sock
```

Start Docker Desktop (Mac/Windows) or `sudo systemctl start docker` (Linux). testcontainers and the chaos suite both require Docker.

### Port conflicts (5433 / 6380 already in use)

The test compose file uses non-standard ports (5433 for Postgres, 6380 for Redis) to avoid clashing with local dev services. If those ports are taken:

```bash
# Find what is using port 5433
lsof -i :5433

# Or override TEST_DATABASE_URL to point at your own Postgres
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5432/credence_test pnpm test
```

### Migration drift (integration tests fail with "relation does not exist")

testcontainers starts a fresh PostgreSQL instance with no schema. Migrations are applied by the test setup code in `tests/integration/testDatabase.ts`. If tests fail because a table is missing:

1. Check that your migration files in `src/migrations/` compile cleanly: `pnpm run build`
2. Verify the migration linter passes: `pnpm run migrate:lint`
3. If you added a new migration, confirm it has a matching `down()` export

When using an external database (`TEST_DATABASE_URL`), run migrations manually first:

```bash
DB_URL=$TEST_DATABASE_URL pnpm run migrate:dev
```

### pg-mem: "function X does not exist"

pg-mem only implements a subset of PostgreSQL built-ins. If a unit test fails with a missing function error, either:
- Register the function manually in the test's `beforeEach` (see `horizonCursor.test.ts` for a `gen_random_uuid` example), or
- Move the test to `tests/integration/` where a real Postgres runs

### Coverage below threshold

```
ERROR: Coverage for statements (38%) does not meet global threshold (40%)
```

Run coverage with the text reporter to see which files are pulling the number down:

```bash
pnpm run coverage -- --reporter=text
```

Then add missing tests or, if the file is genuinely untestable (generated code, infra bootstrap), add it to the `exclude` list in `vitest.config.ts`.

---

## CI Reference

CI runs on `ubuntu-latest` with Node.js 20. It sets `TEST_DATABASE_URL` to a managed PostgreSQL 16 service, bypassing testcontainers. The sequence is:

1. `pnpm install`
2. `pnpm test` — full suite against CI Postgres
3. `pnpm run coverage`
4. `pnpm run coverage:audit`

To reproduce CI locally, start the compose stack and pass the same URL:

```bash
docker compose -f docker-compose.test.yml up -d
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test pnpm run coverage
TEST_DATABASE_URL=postgresql://credence:credence@localhost:5433/credence_test pnpm run coverage:audit
```
