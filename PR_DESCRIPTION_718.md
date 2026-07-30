# Terminate transactions older than 30s to prevent hold-off cascades

Closes #718

## Summary

Adds a `LongTransactionReaper` background job that periodically scans `pg_stat_activity` and calls `pg_terminate_backend()` on any client backend that has held a transaction open past a configurable max age (default 30s, `DB_LONG_TRANSACTION_MAX_AGE_MS`).

## Threat model

**What an attacker (or a buggy code path) gets if this check is missing:** `DB_STATEMENT_TIMEOUT_MS` bounds a single statement, not a transaction — it resets on every new statement. It does nothing for:

- An idle-in-transaction session (no statement is running, so there's nothing to time out).
- A transaction made of many fast statements separated by slow application-level work (e.g. an external HTTP call between two queries inside a transaction).

Either shape holds row/table locks and blocks autovacuum for as long as the transaction stays open. A single request that opens a transaction and then stalls (client disconnect mid-transaction, a slow downstream dependency, or a malicious client that intentionally holds a connection open) can escalate into a hold-off cascade: other requests queue up behind the stale locks, their connections stay checked out of the pool while they wait, and the pool eventually saturates — a low-cost, low-skill denial-of-service against the whole API, not just the offending endpoint. This closes that defence-in-depth gap; there's no report of it being exploited, but it's the kind of gap a careful auditor would flag.

## Changes

- `src/jobs/longTransactionReaper.ts` — the reaper: scoped query (current database only, excludes its own backend, `backend_type = 'client backend'` only), typed `LongTransactionReaperError` on scan failure (never throws raw/unhandled errors or crashes the process), `dryRun` mode, reentrancy guard so overlapping scans no-op instead of piling up, and two Prometheus metrics (`pg_long_transactions_terminated_total`, `pg_long_transaction_age_seconds`).
- `src/jobs/longTransactionReaper.test.ts` — 14 tests, including a negative test (`does NOT terminate anything in dry-run mode, proving dry-run alone is not a guard`) and a scoping test asserting the query can't touch other databases/backends.
- `src/index.ts` — wires the reaper into app startup, gated by `DB_LONG_TRANSACTION_REAPER_ENABLED`, stopped on graceful shutdown; registers its metrics on the shared `/metrics` registry.
- `.env.example`, `docs/CONFIG_TEMPLATE.md`, `docs/timeouts-and-retries.md` — document the four new env vars.

## New env vars

| Var | Default | Purpose |
|---|---|---|
| `DB_LONG_TRANSACTION_REAPER_ENABLED` | `true` | Master on/off switch |
| `DB_LONG_TRANSACTION_MAX_AGE_MS` | `30000` | Transactions open longer than this are terminated |
| `DB_LONG_TRANSACTION_REAPER_INTERVAL_MS` | `10000` | How often `pg_stat_activity` is scanned |
| `DB_LONG_TRANSACTION_REAPER_DRY_RUN` | `false` | Log/count over-age transactions without terminating them |

## Testing

- `npx tsc --noEmit` — clean
- `npm run lint` — clean on all files touched by this change
- `npx vitest run src/jobs/longTransactionReaper.test.ts` — 14/14 passing
- `npm test` — full suite green
- `npm run security:scan` — pre-existing OpenTelemetry advisories only, unrelated to this change

## Out of scope

No hot-path cost to measure: this runs on its own interval timer (default every 10s), not inline with request handling, so it doesn't add latency to any request path.
