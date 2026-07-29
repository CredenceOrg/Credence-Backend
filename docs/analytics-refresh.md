# Analytics Materialized-View Refresh

The analytics read path serves traffic from the `analytics_metrics_mv`
materialized view. A background job (`src/jobs/analyticsRefreshWorker.ts`
+ `src/services/analytics/refreshStrategy.ts`) keeps that view fresh.

## Why REFRESH CONCURRENTLY and not a plain REFRESH

`REFRESH MATERIALIZED VIEW` (without `CONCURRENTLY`) takes an
`ACCESS EXCLUSIVE` lock that **blocks all reads and writes** to the
view for the duration of the rebuild. On a busy table that can be
minutes, which is unacceptable for a read-heavy endpoint.

`REFRESH MATERIALIZED VIEW CONCURRENTLY` is the safe alternative:

- It takes a `SHARE UPDATE EXCLUSIVE` lock instead, which blocks
  autovacuum and DDL but **does not block readers or writers**.
- It rebuilds the view in the background while readers continue
  to see the previous snapshot.
- Old rows remain visible until the rebuild commits, so the view
  is **always readable** during a refresh.

The trade-off: `SHARE UPDATE EXCLUSIVE` *does* still **block
autovacuum**, so if a refresh runs for an hour, autovacuum is
stalled for an hour. That's the exact failure mode this strategy
guards against — see "Bounded lock exposure" below.

## Bounded lock exposure

`AnalyticsRefreshStrategy.refreshViewOnce(view)` runs each view
under a **per-view** `statement_timeout` so a slow REFRESH cannot
monopolize the database's lock manager:

1. The strategy asks the pool for a **dedicated client**
   (`pool.connect()`), so the session-scoped config (statement_timeout)
   does not leak to other pool consumers.
2. It runs `SET statement_timeout = $viewTimeoutMs`.
3. It runs the REFRESH on that client.
4. On exit it runs `RESET statement_timeout` then releases the
   client back to the pool. The RESET runs in a `finally` so it
   still fires if the REFRESH threw.

If the timeout fires, Postgres cancels the refresh and the strategy
classifies the SQLSTATE as `query_canceled (57014)` — a transient
error that gets retried on a fresh dedicated client.

## Strategy: bounded retry on transient errors

`AnalyticsRefreshStrategy.classifyTransientDbError` matches these
SQLSTATE codes:

| SQLSTATE | Kind                  | Reason |
|----------|-----------------------|--------|
| `40001`  | `serialization_failure`| Concurrent writer modified a row the REFRESH read. |
| `40P01`  | `deadlock_detected`   | Two writers took the same row locks in opposite orders. |
| `55P03`  | `lock_not_available`  | Nowait lock timeout — retry after the holder releases. |
| `57P03`  | `cannot_connect_now`  | Server in startup / shutdown / failover. |
| `0800*`  | `connection_exception`| Network blip mid-REFRESH. |
| `53300`  | `too_many_connections`| Pool briefly exhausted — back off and retry. |
| `57014`  | `query_canceled`      | Per-view `statement_timeout` fired. |

These are retried up to `ANALYTICS_REFRESH_MAX_ATTEMPTS_PER_VIEW`
times with `ANALYTICS_REFRESH_RETRY_BACKOFF_MS` between attempts.

**Non-transient errors fail fast** so persistent bugs surface
immediately rather than burning the database on a doomed retry loop.

## Cache generation bump on full success

Readers embed the analytics cache generation in their cache key.
Bumping the generation invalidates every cached summary at once
without enumerating keys. `bumpAnalyticsCacheGeneration()` is
called **only when every registered view succeeded**:

- A partial-success refresh leaves the generation unchanged.
- Readers continue to see values from the *immediately previous*
  fully-successful refresh.
- Mixed generations across views would be impossible to reason
  about coherently, so the strategy is ALL-or-NONE on purpose.

## Consecutive-failure cooldown

If a view fails `ANALYTICS_REFRESH_FAIL_COOLDOWN_THRESHOLD`
times in a row within `ANALYTICS_REFRESH_FAIL_COOLDOWN_MS`
(across ticks), the scheduler stops invoking the strategy for
that view until the cooldown window closes.

Each replica tracks its own consecutive-failure counter in
memory. After a process restart the counter resets — that's
intentional and is the same trade-off that other in-memory
cooldown caches in the codebase make.

During cooldown the scheduler emits
`analytics_scheduler_skips_total{reason="cooldown"}` so the
dashboard can tell a cooldown-driven skip apart from an
overlap- or lock-contention-driven skip.

### Counter reset semantics

The counter is reset to zero on the **next successful refresh of
that view**, regardless of whether it happens within the
threshold window. So a single recovery tick breaks the streak,
which is the desired behavior — we want to clear the cooldown
the moment the underlying problem goes away.

## Configuration

All settings live in `Config.analyticsRefresh` (see
`src/config/index.ts`), validated by zod and overridable via
environment variable:

| Env var | Default | Meaning |
|---------|---------|---------|
| `ANALYTICS_REFRESH_ENABLED` | `true` | Master on/off switch for the whole subsystem. |
| `ANALYTICS_REFRESH_INTERVAL_MS` | `300_000` (5 min) | Time between scheduler ticks. |
| `ANALYTICS_REFRESH_LOCK_TTL_MS` | `600_000` (10 min) | Redis lock TTL — must exceed worst-case refresh duration. |
| `ANALYTICS_REFRESH_VIEW_TIMEOUT_MS` | `60_000` (1 min) | Per-view `statement_timeout`. Bounds the `SHARE UPDATE EXCLUSIVE` exposure. |
| `ANALYTICS_REFRESH_MAX_ATTEMPTS_PER_VIEW` | `3` | Retries on transient SQLSTATE per view per tick. |
| `ANALYTICS_REFRESH_RETRY_BACKOFF_MS` | `1000` | Sleep between per-view retry attempts. |
| `ANALYTICS_REFRESH_FAIL_COOLDOWN_THRESHOLD` | `3` | Consecutive failures before cooldown kicks in. |
| `ANALYTICS_REFRESH_FAIL_COOLDOWN_MS` | `60_000` (1 min) | Cooldown window. |

To disable the entire refresh job for maintenance:
`ANALYTICS_REFRESH_ENABLED=false`. The scheduler still runs setInterval
but its tick is a no-op because the coalescing gate in
`updateConsecutiveFailureStreaks` will mark every view as healthy
already (empty failures) — actually, the master switch is checked
upstream so the scheduler ref is wired only when enabled =
true; when false we log "disabled by config" and skip.

## Observability

Per-view metrics are emitted via `prom-client`. All labels are
**bounded** by the configured `views` list so cardinality explosion
is impossible.

| Metric | Labels | Meaning |
|--------|--------|---------|
| `analytics_refresh_runs_total` | `view`, `status` | Per-view attempts labelled success/error. |
| `analytics_refresh_duration_seconds` | `view` | Per-view last-attempt duration histogram (bucketed 0.1s–5min). |
| `analytics_refresh_transient_retries_total` | `view`, `kind` | Counts transient-retry events by SQLSTATE kind. |
| `analytics_refresh_cache_generation` | (none) | Current generation token, bumped on the last fully-successful tick. |
| `analytics_refresh_consecutive_failures` | `view` | Per-view streak (resets on success). |
| `analytics_scheduler_skips_total` | `reason` | `overlap` / `lock_contention` / `cooldown`. |

### Tracing

The strategy opens a top-level span `analytics.refresh_all` and one
per-view span `analytics.refresh_view` with attributes:

- `analytics.view`: view name
- `statement_timeout_ms`: per-view timeout

Nested `db.query` spans are emitted by `pool.ts`'s
`instrumentQueryTracing` and contain the SQL text.

## Operator runbook

### Symptom: `analytics_refresh_consecutive_failures{view="analytics_metrics_mv"} >= 1`

Indicates a view is failing repeatedly. Drill in with:

```bash
psql $DATABASE_URL -c \
  "SELECT view_name, last_success_at, last_attempt_at, last_error FROM analytics_view_refresh_state;"
```

- If `last_error` mentions `statement_timeout` or `query canceled`:
  raise `ANALYTICS_REFRESH_VIEW_TIMEOUT_MS` if the underlying
  query is genuinely slow (e.g. large `reputation_scores`).
- If `last_error` mentions `deadlock_detected`:
  check for concurrent writers with `pg_stat_activity` and
  the related migration PRs.
- If `last_error` mentions `connection_exception`:
  check `pg_stat_activity` for `idle in transaction` sessions
  that may be holding cross-table locks.

### Symptom: `analytics_scheduler_skips_total{reason="cooldown"}` climbing

A view is in cooldown. Cross-reference with
`analytics_refresh_consecutive_failures{view=...}` for the streak
count. The cooldown auto-clears once the streak is broken on the
next successful refresh; if it isn't, the underlying problem is
persistent (see the per-view drill above).

### Symptom: `analytics_refresh_cache_generation` stops advancing

Cache generation is only bumped on **fully successful** ticks.
If any one view is in cooldown or permanently failing, the
generation will not advance and readers will continue to see
stale data. This is by design; the staleness surface in
`AnalyticsResponse.staleness.refreshStatus` will report
`failed_recently` and callers can branch on it.

### Symptom: `analytics_refresh_duration_seconds{view=...}` 99th percentile climbs

Either the underlying tables are growing (expected) or autovacuum
isn't keeping up. Check `pg_stat_user_tables` for dead tuple ratio
on `identities` and `reputation_scores`. If ratio is high,
tune autovacuum settings (out of scope here) or raise the
per-view timeout so REFRESH has more runway.

## See also

- `src/services/analytics/service.ts` — read path, staleness.
- `src/migrations/002_analytics_materialized_views.ts` — schema.
- `src/services/analytics/refreshStrategy.ts` — implementation.
- `docs/timeouts-and-retries.md` — broader timeout & retry policy.
