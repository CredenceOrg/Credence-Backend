# DB Concurrency Design, Invariants, and Failure Behaviour

## Overview

This document describes the serialization and conflict model for all mutable operations in `src/db/`. Every repository that writes shared state must satisfy the invariants listed here. Reviewers and contributors should treat these as binding contracts.

---

## Serialization and Conflict Behaviour

### Row-level locks (SELECT FOR UPDATE)

Used by: `BondsRepository.debit()`, `WalletsRepository.debit()`, `WalletsRepository.credit()`

- Concurrent writers for the **same row** queue at the database level via `SELECT … FOR UPDATE`.
- Isolation level: `REPEATABLE READ` (prevents phantom reads during the check–update cycle).
- Lock timeout: configurable per `LockTimeoutPolicy` (`READONLY` = 2 s, `DEFAULT` = 5 s, `CRITICAL` = 10 s).
- On timeout: `LockTimeoutError` (wraps PG code `55P03`) is thrown. The transaction is rolled back. No partial state is written.
- Retry on timeout: `retryOnLockTimeout: true` with exponential backoff (controlled by `TransactionOptions.maxRetries`, `retryDelayMs`).

### Optimistic locking (version column)

Used by: `IdentitiesRepository.updateWithOptimisticLocking()`

- `UPDATE … WHERE version = $expected` — succeeds only if no concurrent writer has incremented `version`.
- On conflict: `OptimisticLockError` (HTTP 409) is thrown with `resourceAddress` and `expectedVersion` for client-side retry guidance.
- Callers must re-fetch the resource, reapply their change, and retry.

### Atomic upsert with duplicate detection (xmax)

Used by: `SettlementsRepository.upsert()` / `upsertBatch()`

- A single `INSERT … ON CONFLICT (transaction_hash) DO UPDATE … RETURNING …, xmax` statement.
- `xmax = 0` → fresh insert (no prior row with this `transaction_hash`). `isDuplicate = false`.
- `xmax > 0` → conflict hit (row already existed). `isDuplicate = true`.
- **Why xmax?** The previous two-step `SELECT` + `INSERT/ON CONFLICT` was a TOCTOU race: between the `SELECT` and the `INSERT`, a concurrent writer could insert the same `transaction_hash`, causing both writers to believe they were first. The single-statement `xmax` approach eliminates this race entirely—the atomicity of the `INSERT … ON CONFLICT` guarantees exactly one winner.

### Serialization failure / deadlock / lock timeout retry

Used by: `withRetryableTransaction`, `withRetryableTransactionManager` (see `src/db/retry.ts`)

- Retryable codes: `40001` (serialization failure), `40P01` (deadlock), `40000`/`40002`/`40003` (transaction rollback variants), **`55P03` (lock_not_available / lock_timeout)**.
- Non-retryable codes (fail fast): `23505` (unique), `23503` (FK), `23502` (not null), `23514` (check), etc.
- Backoff: full jitter exponential — `random(0, min(maxBackoffMs, initialBackoffMs × 2^attempt))`.
- Default: `maxRetries = 3`, `initialBackoffMs = 50 ms`, `maxBackoffMs = 1000 ms`.
- **Note on `55P03`**: `isRetryableError()` explicitly includes this code so that the retry loop does not exit early before all attempts are consumed. After exhaustion, a `ConflictError` with `conflictCode = 'lock_timeout'` is thrown—the same contract as serialization failures and deadlocks.

---

## Retry Contract for HTTP Callers

When retries are exhausted on a **concurrency conflict** (serialization failure, deadlock, or lock timeout), `withRetryableTransaction` and `withRetryableTransactionManager` throw a `ConflictError` instead of the generic `MaxRetriesExhaustedError`. This allows HTTP handlers to:

1. Return `409 Conflict` instead of `500 Internal Server Error`.
2. Set a `Retry-After` header using `ConflictError.retryAfterSeconds`.
3. Include a machine-readable `conflictCode` in the response body (`serialization_failure`, `deadlock`, `lock_timeout`, `optimistic_lock`).

```typescript
import { ConflictError } from './db/retry.js'

// In an Express error handler or route:
} catch (err) {
  if (err instanceof ConflictError) {
    res.set('Retry-After', String(err.retryAfterSeconds))
    return res.status(409).json({
      error: err.message,
      code: err.conflictCode,
      retryAfterSeconds: err.retryAfterSeconds,
    })
  }
  next(err)
}
```

Non-retryable errors (constraint violations, data errors) are always re-thrown immediately without wrapping.

---

## Partial State Guarantees

### Principle: all-or-nothing writes

Every mutating repository method that involves multiple queries must execute inside a single `TransactionManager.withTransaction` (or be called from within an already-active outer transaction via AsyncLocalStorage propagation). This ensures PostgreSQL's `BEGIN … COMMIT` atomicity: either all writes succeed and are committed, or none are committed.

| Scenario | Behaviour |
|----------|-----------|
| Exception thrown inside `withTransaction` callback | Automatic `ROLLBACK`. Post-commit hooks **do not** fire. Rollback hooks fire. No partial state in DB. |
| `LockTimeoutError` | Immediate `ROLLBACK`. Post-commit hooks **do not** fire. |
| `TransactionBudgetError` (duration or savepoint budget) | Immediate `ROLLBACK`. Post-commit hooks **do not** fire. |
| Successful commit | All queries committed atomically. Post-commit hooks fire in registration order. |

### Post-commit hooks (cache invalidation, metrics, events)

Registered via `runPostCommit(hook)`. Hooks run **after** `COMMIT` completes. If any hook throws, remaining hooks continue (errors are logged but not re-thrown). This ensures partial hook failures do not affect DB consistency.

**Critical invariant:** post-commit hooks must not depend on transactional state that could be rolled back. They should only invalidate caches, emit metrics, or publish outbox events — not write to the DB without their own transaction.

### Rollback hooks (compensating actions)

Registered via `runRollback(hook)`. Hooks run **after** `ROLLBACK` completes. Typical uses: logging, metrics, signalling that a resource reservation should be undone. Rollback hooks do not themselves have access to the rolled-back data.

### upsertBatch atomicity

`SettlementsRepository.upsertBatch()` uses `TransactionManager.withTransaction` when a `Pool` is supplied at construction, ensuring:

- All rows in the batch are committed atomically.
- On failure mid-batch, all prior inserts in the batch are rolled back.
- Post-commit hooks fire once (after the batch commits), not once per row.

If no `Pool` is supplied, `upsertBatch` falls back to sequentially calling `_upsert` through the provided `Queryable`. If that `Queryable` is already a `PoolClient` inside a transaction, batch atomicity is inherited from the outer transaction. If it is a bare `Pool`, atomicity is **not** guaranteed — always supply a `Pool` to the constructor for batch operations.

---

## Transaction Context Propagation

`TransactionManager.withTransaction` uses `AsyncLocalStorage` to propagate the active `PoolClient` and `TransactionContext` (hooks) across the async call graph. This means:

- Any `pool.query(...)` call made from within the callback is automatically redirected to the active transaction client, even through multiple layers of service/repository calls.
- `runPostCommit` and `runRollback` can be called from any depth inside the callback.
- Nested `withTransaction` calls reuse the outer transaction's client (no nested BEGIN).

---

## Failure Scenarios and Recovery

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Lock timeout | PG code `55P03` → `LockTimeoutError` (via `TransactionManager`) or `ConflictError` (via `withRetryableTransaction` after exhaustion) | Retry via `retryOnLockTimeout: true` in `TransactionManager`, or caller handles 409 with `Retry-After` from `ConflictError.retryAfterSeconds` |
| Serialization failure | PG code `40001` → `ConflictError` after retries | Caller retries using `Retry-After` |
| Deadlock | PG code `40P01` → `ConflictError` after retries | Caller retries using `Retry-After` |
| Unique constraint | PG code `23505` → original error (no wrap) | Caller handles idempotency (check `isDuplicate` flag) |
| FK violation | PG code `23503` → original error | Fix input data |
| DB connection drop | `ECONNRESET` etc. → retried | Pool reconnects automatically |
| Mid-batch failure in upsertBatch | FK or constraint error → rollback | Entire batch is rejected; caller must retry the full batch |
| Post-commit hook failure | Logged, remaining hooks continue | Stale cache; next read will miss and repopulate |

---

## Compatibility Impact

### `SettlementsRepository` constructor change

`SettlementsRepository` now accepts an optional `pool?: Pool` second argument:

```typescript
// Before (compatible — pool was not accepted)
new SettlementsRepository(db)

// After (compatible)
new SettlementsRepository(db)

// New — enables TransactionManager for upsertBatch atomicity
new SettlementsRepository(db, pool)
```

The `isDuplicate` flag in `UpsertSettlementResult` is semantically unchanged: `false` = fresh row, `true` = pre-existing row updated. The mechanism changed from a two-step SELECT+INSERT (TOCTOU race) to a single atomic INSERT with `xmax` inspection.

### `retry.ts` — new exported types

`ConflictError`, `ConflictRetryInfo`, and `classifyConflict` are new exports. Existing code that only catches `MaxRetriesExhaustedError` will continue to work for non-conflict failures. For conflict failures, the thrown type changes from `MaxRetriesExhaustedError` to `ConflictError`; callers that perform an `instanceof MaxRetriesExhaustedError` check on retryable-conflict exhaustion will no longer match. Update those checks to also handle `ConflictError`, or catch the common supertype `Error`.

### `transaction.ts` — dead code removal

The outer `context` declaration (no `correlationId`) inside `withTransaction` was dead code shadowed by the inner `context` in the retry loop. Removed. Behaviour is unchanged.

The duplicate `getTenantId` / `runWithTenant` at the end of `transaction.ts` that used an undefined `tenantStorage` variable are removed. These functions are now solely provided by `src/utils/tenantContext.ts`, which is the canonical source. Nobody imported them from `transaction.ts`.

---

## Migration and Rollback Considerations

- No database schema changes in this PR. All changes are application-layer.
- `SettlementsRepository` constructor is additive; no callers need updating unless they want batch atomicity.
- `ConflictError` is additive to the error hierarchy. Existing catch blocks that check `instanceof MaxRetriesExhaustedError` will miss conflict errors on exhaustion; add a `ConflictError` branch to handle 409 correctly.
- Rollback procedure: revert the changed files. No DB migration needed.

---

## Operational Limitations

- `withRetryableTransaction` does NOT integrate with `TransactionManager` (different code paths). If you need both retry-on-serialization-failure and lock-timeout policy, use `withRetryableTransactionManager` wrapping a `TransactionManager`.
- Post-commit hooks are in-process and synchronous in sequence. Hook failures are logged but do not cause the overall operation to fail. Operators should monitor `console.error` / structured logs for hook failures.
- `upsertBatch` without a pool is not atomic — document this at call sites.

---

## Security Assumptions

- All SQL parameters are passed via parameterized queries (`$1`, `$2`, …). No string concatenation of user-supplied values.
- Tenant ID injection into transaction context (`SET LOCAL app.tenant_id = $1`) uses `set_config` with a bind parameter to prevent SQL injection.
- `xmax` is a PostgreSQL internal system column. It is cast to `::text` in the RETURNING clause and compared as a string (`!== '0'`). It cannot be forged by application-layer input.
- Lock timeouts are enforced by the database, not the application. An application crash mid-transaction does not leave locked rows; the connection pool recycles the connection and PostgreSQL aborts the transaction.
- Post-commit hooks execute after the DB transaction is committed. A process crash between COMMIT and hook execution will leave the cache stale (no data loss). The next successful read repopulates the cache.
