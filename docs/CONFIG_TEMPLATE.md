# Configuration Template — every env var, default, and notes

Audience: **contributors** setting up a local dev environment. Copy
`.env.example` to `.env`, then use this document to know which values you must
set, which have safe defaults, and what each one controls.

```bash
cp .env.example .env
docker compose up -d postgres redis
npm run migrate   # requires DATABASE_URL (see below)
npm run dev
```

## How configuration is validated

At startup the app parses `process.env` through a Zod schema (`envSchema` in
`src/config/index.ts`) via `loadConfig()`:

- **Invalid or missing required values abort startup.** Validation failures
  throw `ConfigValidationError` listing every offending variable and reason;
  outside `NODE_ENV=test` the process logs the list and exits with code 1.
- **Numeric vars are strings in `.env`** and are transformed to numbers by the
  schema, with min/max bounds enforced (documented below).
- **Boolean vars** are the string `'true'` / `'false'`; only the exact string
  `'true'` enables the flag.

## Required variables (no default — startup fails without them)

| Variable | Constraint | Notes |
| --- | --- | --- |
| `DB_URL` | Valid URL | PostgreSQL connection string used by the app config (`postgresql://user:password@localhost:5432/credence`). |
| `REDIS_URL` | Valid URL | e.g. `redis://localhost:6379`. |
| `JWT_SECRET` | ≥ 32 characters | Symmetric fallback secret. Generate with `openssl rand -hex 32`. |
| `DATABASE_URL` | `postgres://` / `postgresql://` / `pg-mem://` | Required by the **migration runner** (`src/migrations/config.ts`), separate from `DB_URL`. Set both to the same database for local dev. In docker-compose it is composed from `POSTGRES_*`. |
| `EVIDENCE_ENCRYPTION_KEY` | **exactly 32 bytes** (UTF-8) | AES-256-GCM key-encryption-key for evidence storage (`src/services/keyManager`). Any 32-character string works for dev; use `openssl rand -hex 16` output equivalents in production. |
| `REPORT_STORAGE_SIGNING_SECRET` | non-empty, ≥ 32 chars recommended | HMAC secret for signed report-artifact download URLs (`src/services/reportStorage.ts`). |

## Server

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `PORT` | `3000` | 1–65535 | Backend listen port. |
| `NODE_ENV` | `development` | `development` / `production` / `test` | `production` tightens error responses (no `details`, catalog default messages only). |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` | |
| `SHUTDOWN_GRACE_PERIOD_MS` | `30000` | ≥ 1000 | Grace window for graceful shutdown. See [graceful-shutdown.md](graceful-shutdown.md). |
| `NODE_MAX_OLD_SPACE_SIZE_MB` | unset | 128–32768 | Starts node with `--max-old-space-size`. Optional. |
| `CORS_ORIGIN` | `*` | string | `*` is fine for dev/test; per `.env.example` policy, production must use a single origin or comma-separated allowlist. |

## Database pool and lock timeouts

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `DB_POOL_MAX` | `20` | 1–200 | Max connections in the API pool. |
| `DB_POOL_IDLE_TIMEOUT_MS` | `30000` | ≥ 0 | Idle client lifetime before close. |
| `DB_POOL_CONNECTION_TIMEOUT_MS` | `5000` | 1000–30000 | Wait for a free connection before erroring. |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | ≥ 0 | Per-statement timeout; kills runaway queries. |
| `DB_WORKER_POOL_MAX` | `5` | 1–50 | Separate pool for background jobs. |
| `DB_REPLICA_POOL_MAX` | `DB_POOL_MAX` | 1–200 (optional) | Max connections in the read-replica pool; falls back to `DB_POOL_MAX` when unset. |
| `MAX_REPLICA_LAG_MS` | `1000` | ≥ 0 | Max replication lag before `withReplica()` falls back to the primary pool. |
| `DB_LOCK_TIMEOUT_READONLY_MS` | `1000` | 100–30000 | Lock timeout for read-only queries. See [lock-timeout-configuration.md](lock-timeout-configuration.md). |
| `DB_LOCK_TIMEOUT_DEFAULT_MS` | `2000` | 100–30000 | Standard read-modify-write operations. |
| `DB_LOCK_TIMEOUT_CRITICAL_MS` | `10000` | 100–60000 | Critical flows that may wait longer. |

> Note: the schema names carry the `_MS` suffix. `.env.example` also lists
> legacy `DB_LOCK_TIMEOUT_READONLY` / `_DEFAULT` / `_CRITICAL` names — prefer
> the `_MS` names above.

## Long transaction reaper

Defence-in-depth job that terminates backends holding a transaction open too
long (`src/jobs/longTransactionReaper.ts`). Unlike `DB_STATEMENT_TIMEOUT_MS`,
this also catches idle-in-transaction sessions and multi-statement
transactions with slow app-level pauses between statements — both hold
locks and block autovacuum without ever tripping a per-statement timeout.

| Variable | Default | Notes |
| --- | --- | --- |
| `DB_LONG_TRANSACTION_REAPER_ENABLED` | `true` | Master on/off switch. |
| `DB_LONG_TRANSACTION_MAX_AGE_MS` | `30000` | Transactions open longer than this are terminated via `pg_terminate_backend`. |
| `DB_LONG_TRANSACTION_REAPER_INTERVAL_MS` | `10000` | How often `pg_stat_activity` is scanned. |
| `DB_LONG_TRANSACTION_REAPER_DRY_RUN` | `false` | When `true`, over-age transactions are logged/counted but not terminated. |

## Authentication and JWT key rotation

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `JWT_EXPIRY` | `1h` | string | Token lifetime. |
| `KEY_ROTATION_INTERVAL_SECONDS` | `86400` | positive int | How often the active signing key rotates (24 h). |
| `KEY_GRACE_PERIOD_SECONDS` | `3600` | ≥ 0 | How long a retired key still verifies old tokens. |
| `KEY_CLOCK_SKEW_SECONDS` | `300` | ≥ 0 | Skew tolerance; also passed as `clockTolerance` to `jwtVerify()`. |
| `KEY_PRIVATE_PEM` | unset | PKCS8 PEM | Optional initial RSA signing key; when set, tokens survive restarts. Generate with `openssl genrsa 2048 \| openssl pkcs8 -topk8 -nocrypt`. Inject via a secret manager in production. |
| `KEY_INITIAL_KID` | random UUID | string | Stable `kid` for the key loaded from `KEY_PRIVATE_PEM`. |

## Feature flags

| Variable | Default | Notes |
| --- | --- | --- |
| `ENABLE_TRUST_SCORING` | `false` | Enable trust-scoring paths. |
| `ENABLE_BOND_EVENTS` | `false` | Enable bond-event processing. |
| `FLAG_CACHE_TTL_MS` | `30000` | In-process TTL for the feature-flag cache. Currently a hardcoded constant in `src/services/featureFlags/consts.ts` — the `.env.example` entry is aspirational; changing it requires a code edit. |

## Outbox pattern

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `OUTBOX_ENABLED` | `true` | | See [outbox-scaling.md](outbox-scaling.md). |
| `OUTBOX_POLL_INTERVAL_MS` | `1000` | ≥ 100 | |
| `OUTBOX_BATCH_SIZE` | `100` | ≥ 1 | |
| `OUTBOX_PUBLISHED_RETENTION_DAYS` | `7` | ≥ 1 | |
| `OUTBOX_FAILED_RETENTION_DAYS` | `30` | ≥ 1 | |
| `OUTBOX_CLEANUP_INTERVAL_MS` | `3600000` | ≥ 60000 | |

## Request snapshots

| Variable | Default | Constraint |
| --- | --- | --- |
| `REQUEST_SNAPSHOT_RETENTION_DAYS` | `14` | ≥ 1 |
| `REQUEST_SNAPSHOT_CLEANUP_INTERVAL_MS` | `86400000` | ≥ 60000 |
| `REQUEST_SNAPSHOT_CLEANUP_ENABLED` | `true` | |

## Expired sessions sweeper

Periodically deletes `idempotent_job_attempts` rows whose `expires_at` has
passed, preventing unbounded table growth.

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `SESSION_TTL_SECONDS` | `86400` | 60–2592000 | TTL (seconds) applied to new session rows. The sweeper removes rows whose `expires_at` ≤ NOW(). |
| `SESSION_SWEEP_INTERVAL_MS` | `3600000` | ≥ 60000 | How often (ms) the sweeper runs. |

The sweeper is started automatically at application boot when `DATABASE_URL` is
set. It follows the same batch-delete pattern as the idempotency-key sweeper
and is stopped during graceful shutdown.

## Rate limiting

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `true` | | Master switch. |
| `RATE_LIMIT_WINDOW_SEC` | `60` | 1–3600 | Window length. |
| `RATE_LIMIT_MAX_FREE` | `100` | ≥ 1 | Requests per window, free tier. |
| `RATE_LIMIT_MAX_PRO` | `1000` | ≥ 1 | Pro tier. |
| `RATE_LIMIT_MAX_ENTERPRISE` | `10000` | ≥ 1 | Enterprise tier. |
| `RATE_LIMIT_FAIL_OPEN` | `true` in dev/test, `false` in production | | Behavior when the limiter backend is down. Fail-closed in production unless explicitly set to `'true'`. |

## Credits / billing

| Variable | Default | Notes |
| --- | --- | --- |
| `ENDPOINT_COST_WEIGHTS` | `{"default":1,"/bulk/verify":10,"/reports":5}` | JSON object mapping endpoint prefixes to credit costs. |
| `DEFAULT_MONTHLY_CREDITS` | `10000` | ≥ 0 |
| `DEFAULT_LOW_CREDIT_THRESHOLD` | `100` | ≥ 0 |

## External services and timeouts

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `HORIZON_URL` | unset | valid URL | Optional Stellar Horizon endpoint (e.g. `https://horizon-testnet.stellar.org`). See [horizon-listener.md](horizon-listener.md). |
| `TIMEOUT_DB_MS` | `2000` | 100–30000 | Timeout budgets for outbound dependencies. See [timeouts-and-retries.md](timeouts-and-retries.md). |
| `TIMEOUT_CACHE_MS` | `500` | 50–10000 | |
| `TIMEOUT_QUEUE_MS` | `1000` | 100–15000 | |
| `TIMEOUT_HTTP_MS` | `5000` | 1000–60000 | |
| `TIMEOUT_SOROBAN_MS` | `5000` | 100–45000 | |
| `TIMEOUT_WEBHOOK_MS` | `10000` | 2000–60000 | |
| `WEBHOOK_PAYLOAD_SIZE_CAP` | `262144` | 1024–10485760 | Webhook payload size cap in bytes (256 KiB default). |

## Outbound retry policy

Global defaults plus optional per-provider overrides (`SOROBAN`, `WEBHOOK`):

| Variable | Default | Constraint |
| --- | --- | --- |
| `OUTBOUND_RETRY_MAX_ATTEMPTS` | `3` | ≥ 1 |
| `OUTBOUND_RETRY_BASE_DELAY_MS` | `200` | ≥ 1 |
| `OUTBOUND_RETRY_MAX_DELAY_MS` | `2000` | ≥ 1 |
| `OUTBOUND_RETRY_BACKOFF_MULTIPLIER` | `2` | ≥ 1 |
| `OUTBOUND_RETRY_JITTER_STRATEGY` | `none` | `none` / `full` / `equal` |
| `OUTBOUND_RETRY_SOROBAN_*` | unset | Same five knobs, Soroban-only override. |
| `OUTBOUND_RETRY_WEBHOOK_*` | unset | Same five knobs, webhook-only override. |

## Soroban RPC circuit breaker and cache

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `SOROBAN_CIRCUIT_BREAKER_FAILURE_THRESHOLD` | `5` | ≥ 1 | Consecutive failures before the breaker opens. |
| `SOROBAN_CIRCUIT_BREAKER_OPEN_WINDOW_MS` | `10000` | ≥ 1000 | Fail-fast window while OPEN. |
| `SOROBAN_CIRCUIT_BREAKER_HALF_OPEN_AFTER_MS` | `30000` | ≥ 1000 | When a probe request is allowed through. |
| `SOROBAN_CIRCUIT_BREAKER_COOLDOWN_MS` | unset | ≥ 1000 | **Deprecated** alias; maps to `HALF_OPEN_AFTER_MS` when the new var is absent. |
| `SOROBAN_STATE_CACHE_TTL_MS` | `5000` | ≥ 0 | Read-through cache TTL for `getIdentityState()`; `0` disables. |

## Reputation scoring model

| Variable | Default | Constraint | Notes |
| --- | --- | --- | --- |
| `REPUTATION_MODEL_VERSION` | `1.0.0` | string | Recorded in score snapshots. |
| `REPUTATION_BOND_SCORE_MAX` | `50` | 0–100 | Max points for bond amount (achieved at ≥ 1 ETH). |
| `REPUTATION_DURATION_SCORE_MAX` | `20` | 0–100 | Max points for bond duration (≥ 365 days). |
| `REPUTATION_ATTESTATION_SCORE_MAX` | `30` | 0–100 | Max points for attestations (≥ 5). |
| `REPUTATION_ONE_ETH_WEI` | `1000000000000000000` | valid BigInt string | |
| `REPUTATION_MAX_DURATION_DAYS` | `365` | ≥ 1 | |
| `REPUTATION_MAX_ATTESTATION_COUNT` | `5` | ≥ 1 | |

## Miscellaneous

| Variable | Default | Notes |
| --- | --- | --- |
| `TRUST_SCORE_CACHE_TTL` | `600` | Seconds; 60–86400. |
| `AUDIT_EXPORT_MAX_WINDOW_DAYS` | `90` | 1–3650. |
| `EXPORT_MAX_ROWS` | `100000` | 1–10000000. Hard row cap for authenticated data exports; oversized requests return 413 before streaming. See [export.md](export.md). |
| `REPORT_MAX_CONCURRENT_JOBS_PER_ORG` | `10` | 0–1000. |
| `REPORT_DOWNLOAD_BASE_URL` | `https://credence.example.com` | Base URL embedded in signed report download links (`src/services/reportStorage.ts`). |
| `METRICS_ALLOWED_CIDRS` | unset | Comma-separated IPv4 CIDRs allowed to scrape `/metrics`; unset = open. |
| `ANALYTICS_REFRESH_CRON` | `*/5 * * * *` | Cron for the analytics materialized-view refresh worker (`src/jobs/analyticsRefreshWorker.ts`). |
| `ANALYTICS_STALENESS_SECONDS` | `300` | Staleness budget for analytics responses. |
| `COMPRESSION_THRESHOLD` | `1024` | Minimum response bytes before gzip kicks in (`src/middleware/compression.ts`). |

## Docker-compose-only variables

Consumed by `docker-compose.yml`, not by the app directly:

| Variable | Default | Notes |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `credence` | Container credentials; compose builds `DATABASE_URL` from them. |
| `POSTGRES_PORT` | `5432` | Host-exposed Postgres port. |
| `REDIS_PORT` | `6379` | Host-exposed Redis port. |
| `TEST_DATABASE_URL` | unset | Integration tests connect directly to this URL instead of spinning up testcontainers (required in CI; matches `docker-compose.test.yml`). Reset locally with `npm run test:db:reset` (see [local-testing-guide.md](./local-testing-guide.md)). |

## Common pitfalls

- **`JWT_SECRET must be at least 32 characters`** — the single most common
  startup failure. `openssl rand -hex 32`.
- **`EVIDENCE_ENCRYPTION_KEY` must be exactly 32 bytes** — not "at least".
  The example value (`12345678901234567890123456789012`) works for dev only.
- **Migrations need `DATABASE_URL`, the app needs `DB_URL`** — set both to the
  same database; forgetting `DATABASE_URL` fails `npm run migrate` with an
  explicit error.
- **`CORS_ORIGIN=*` must not be used in production** (documented policy in
  `.env.example`) — set an explicit allowlist.
- **Booleans are strings** — `OUTBOX_ENABLED=1` does *not* enable the outbox;
  only `'true'` does.
- **Validation errors list every problem at once** — fix top-down; later
  entries are often cascading defaults.
