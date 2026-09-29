# Connection Pool Metrics & Alerting

## Exposed Metrics

| Metric | Source | Description |
|---|---|---|
| `activeConnections` | `pool.totalCount - pool.idleCount` | Currently in-use connections |
| `idleConnections` | `pool.idleCount` | Idle connections available for reuse |
| `pendingRequests` | `pool.waitingCount` | Queued requests awaiting a connection |
| `maxPoolSize` | Config `db.pool.max` / `db.workerPool.max` / `db.replicaPool.max` | Hard cap per pool |
| `saturationRatio` | `activeConnections / maxPoolSize` | Fraction of pool capacity consumed |

## Alert Threshold

| Threshold | Action |
|---|---|
| `saturationRatio > 0.80` (80%) | `logger.warn` emitted with pool name, metric snapshot, and ratio |

## Recovery Runbooks

### 1. Saturation Alert Fires

**Symptoms:** `saturationRatio` exceeds 0.80 on any pool. `pendingRequests` may be climbing.

**Steps:**
1. Identify the affected pool from the log line (`pool` field: `api`, `worker`, or `replica`).
2. Check `activeConnections` — if near `maxPoolSize`, the pool is exhausted.
3. Inspect `pendingRequests` — a non-zero value confirms queuing pressure.
4. Review slow-query logs (`db:slow-query`) for concurrent long-running queries holding connections.
5. Verify downstream database CPU / IO — the bottleneck may be on Postgres, not the pool.

**Mitigation:**
- Kill runaway queries identified in slow-query logs via `pg_terminate_backend()`.
- If sustained, increase pool max via config (`DB_POOL_MAX`, `DB_WORKER_POOL_MAX`, `DB_REPLICA_POOL_MAX`) and restart.
- Add read replicas and route read-heavy traffic to `replicaPool` via `withReplica()`.

### 2. Pending Request Queue Growing

**Symptoms:** `pendingRequests` rising even if `saturationRatio` is moderate.

**Steps:**
1. Check if database CPU is saturated — queries may be slow but not holding connections.
2. Verify connection pool `idleTimeoutMillis` — idle connections held too long reduce effective capacity.
3. Check for connection leaks — compare `activeConnections` at steady state vs. baseline.

**Mitigation:**
- Reduce `statement_timeout` to free connections faster.
- Investigate long-held transactions or missing `client.release()` calls.
- Use `pool.on("error")` and `pool.on("remove")` listeners (already registered) to detect unexpected removals.

### 3. False Positive / Transient Spike

**Symptoms:** Alert fires briefly then self-resolves within one poll cycle (10s).

**Steps:**
1. Check the saturation ratio in the log — if only marginally above 0.80, this is a transient spike.
2. Correlate with deployment or traffic events at the same timestamp.
3. If frequent, consider raising the threshold or adding hysteresis (e.g., require 3 consecutive polls above threshold before alerting).

## Poll Configuration

| Parameter | Value |
|---|---|
| Poll interval | 10 000 ms (10 s) |
| Threshold | 0.80 (80 %) |
| Timer | `setInterval`, `unref()` — does not prevent process exit |
