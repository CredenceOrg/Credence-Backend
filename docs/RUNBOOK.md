# On-Call Runbook

This runbook is for operators managing the Credence Backend in production. It covers common alerts, diagnostic procedures, and rollback steps.

**Audience:** Operators and on-call engineers  
**Last updated:** 2026-06-25

---

## Quick Reference

| Alert                             | Severity | First Response | Root Cause                                                     | Fix                                                                             |
| --------------------------------- | -------- | -------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `CredenceTrustScoreHighErrorRate` | SEV1     | Page 🔴        | DB down, bug, or dependency failure                            | [Diagnose](#step-1-check-service-health), then [escalate](#escalation)          |
| `CredenceSettlementDrift`         | SEV1     | Page 🔴        | Reconciliation failure or data corruption                      | [Diagnose](#step-1-check-service-health), check reconciliation logs             |
| `RedisUnavailable`                | SEV1     | Page 🔴        | Cache layer down or misconfigured                              | [Diagnose Redis](#redis-unavailable)                                            |
| `PostgresDown`                    | SEV1     | Page 🔴        | Database unreachable or crashed                                | [Diagnose DB](#postgres-down)                                                   |
| `HighLatencyP99`                  | SEV2     | Ticket 🟠      | Slow queries, connection pool saturation, or lock contention   | [Diagnose](#step-1-check-service-health), check [lock timeouts](#lock-timeouts) |
| `BulkVerificationFailureRate`     | SEV2     | Ticket 🟠      | Migration issue, missing index, or external dependency timeout | Check logs for patterns                                                         |
| `ConnectionPoolSaturation`        | SEV2     | Ticket 🟠      | Long-running queries or transaction deadlock                   | [Check connections](#connection-pool-saturation)                                |
| `OutboxPublisherLagHigh`          | SEV2     | Ticket 🟠      | Webhook delivery slow or downstream service down               | Check webhook logs                                                              |

---

## Step 1: Check Service Health

**What to run:**

```bash
# 1. Check service liveness (always returns 200 if process is running)
curl -s http://localhost:3000/api/health/live | jq .

# Expected output:
# {
#   "status": "ok",
#   "service": "credence-backend"
# }

# 2. Check readiness (deep check of all dependencies)
curl -s http://localhost:3000/api/health | jq .

# Expected output:
# {
#   "status": "ok",
#   "service": "credence-backend",
#   "dependencies": {
#     "db": { "status": "up" },
#     "cache": { "status": "up" },
#     "horizonListener": { "status": "up", "lastHeartbeat": "2s ago" },
#     "outboxPublisher": { "status": "up", "lastHeartbeat": "1s ago" }
#   }
# }

# 3. Check Prometheus metrics
curl -s http://localhost:3000/metrics | grep -E "credence_.*error_rate|credence_.*latency"
```

**Interpretation:**

- ✅ **All `status: "up"`**: Service is healthy; issue is likely downstream or transient.
- ❌ **Any `status: "down"`**: Go to the diagnostic section for that dependency.
- ⚠️ **Liveness up, readiness down**: Critical dependency is unreachable. Check network and credentials.

---

## Step 2: Check Logs

**What to run:**

```bash
# If running in Kubernetes:
kubectl logs -f deployment/credence-backend -c backend --tail=100

# If running in Docker Compose:
docker compose logs -f backend --tail=100

# Filter for errors only:
docker compose logs backend --tail=500 | grep -i "error\|fatal\|panic"

# Filter for a specific request ID (from error response):
docker compose logs backend --tail=1000 | grep "RequestID: <request-id>"
```

**Look for:**

- `ERROR` or `FATAL` level entries with timestamps
- Stack traces indicating the failure point
- Request ID correlations if investigating a specific request
- Repeated messages that might indicate a crash loop

**Example of actionable log:**

```
[ERROR] [RequestID: 550e8400] [CorrelationID: 550e8401] - Database connection refused: connect ECONNREFUSED 127.0.0.1:5432
```

→ Database is down. Proceed to [PostgreSQL Down](#postgres-down).

---

## Step 3: Query Prometheus

**What to run:**

```bash
# Query error rate over the last 5 minutes (from Prometheus/Grafana dashboard)
# PromQL:
rate(http_requests_total{status=~"5.."}[5m])

# Query p99 latency
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# Query database connection count
pg_stat_activity_count

# Query cache hit rate
rate(redis_commands_processed_total{command="get"}[5m]) /
rate(redis_commands_total[5m])

# Check graceful shutdown metrics (indicates recent restart)
rate(shutdown_total[5m])
```

**Interpretation:**

- **High error rate** (> 5%): Possible bug or external dependency issue.
- **p99 latency > 1s**: Slow queries or connection pool issues.
- **Cache hit rate < 50%**: Performance issue; may need to investigate cache invalidation.
- **Frequent shutdowns**: Possible crash loop; check logs for root cause.

---

## Common Alerts and Diagnostics

### PostgreSQL Down

**Alert:** `PostgresDown` (SEV1) | Response: Page immediately

**Step 1: Verify connectivity**

```bash
# From the pod/container:
psql "$DATABASE_URL" -c "SELECT 1"

# If fails: "could not translate host name"
# → DNS issue or misconfigured CONNECTION_URL
# Fix: Verify DATABASE_URL and cluster DNS resolution

# If fails: "connection refused"
# → PostgreSQL is down or port is wrong
# Fix: Check PostgreSQL logs and cluster status
```

**Step 2: Check replica status (if applicable)**

```sql
-- Connect to primary
SELECT datname, usename, application_name, state, write_lsn, flush_lsn, replay_lsn
FROM pg_stat_replication;

-- If replicas are lagging or missing
-- → Wait for replica to catch up or manually promote a standby
```

**Step 3: Check for long-running transactions**

```sql
SELECT pid, usename, query_start, state, query
FROM pg_stat_activity
WHERE state != 'idle' AND query_start < now() - interval '5 minutes';

-- Kill if safe (don't kill system processes):
-- SELECT pg_terminate_backend(pid);
```

**Rollback steps:**

1. If you can restore from backup:
   ```bash
   npm run drill:restore
   ```
2. If you need to trigger a planned failover:
   - Contact infrastructure team to promote read-only replica
   - Update `DATABASE_URL` connection string
   - Restart the backend service

---

### Redis Unavailable

**Alert:** `RedisUnavailable` (SEV1) | Response: Page immediately

**Step 1: Test Redis connectivity**

```bash
# From the pod/container:
redis-cli -u "$REDIS_URL" ping

# Expected: PONG
# If fails: "Could not connect" → Redis is down
```

**Step 2: Check Redis logs**

```bash
# If using Kubernetes:
kubectl logs -f deployment/redis -c redis --tail=100

# If using Docker Compose:
docker compose logs redis --tail=100
```

**Step 3: Restart Redis (if safe)**

```bash
# If Redis process crashed or is hung:
docker compose restart redis

# Then verify it comes back up:
redis-cli -u "$REDIS_URL" ping
```

**Rollback steps:**

1. If cache is stale after restart, clear it and let it repopulate:
   ```bash
   redis-cli -u "$REDIS_URL" FLUSHALL
   ```
2. Cache miss rate will spike temporarily; monitor until stabilized
3. If Redis keeps crashing, check memory usage and eviction policy

---

### High Latency (p99 > 1s)

**Alert:** `HighLatencyP99` (SEV2) | Response: Create ticket, investigate

**Step 1: Check database query performance**

```sql
-- Find slow queries:
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- If query is > 100ms:
-- Analyze the query plan
EXPLAIN ANALYZE <slow_query>;

-- Check index usage:
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC
LIMIT 10;
```

**Step 2: Check connection pool saturation**

```bash
# Query Prometheus:
# pg_stat_activity_count - Count of active connections
# If close to pool size: Possible connection leak or slow client

# Check pool config:
echo $DATABASE_POOL_MIN
echo $DATABASE_POOL_MAX
```

**Step 3: Check for lock contention** (see [Lock Timeouts](#lock-timeouts))

```sql
SELECT pid, usename, application_name, state, query
FROM pg_stat_activity
WHERE wait_event_type = 'Lock';

-- If multiple pids waiting on locks:
-- Identify the blocker and terminate if safe
SELECT DISTINCT blocking_pids, pid, query
FROM pg_blocking_pids();
```

**Rollback steps:**

1. **Increase query timeout** (short-term):
   ```bash
   TIMEOUT_DB_MS=5000 # Increase from default 2000
   ```
2. **Add missing index** (if identified):
   ```bash
   npm run migrate:create -- --name add_performance_index --online
   ```
3. **Restart** backend service to reset connection pool if it's the bottleneck

---

### Connection Pool Saturation

**Alert:** `ConnectionPoolSaturation` (SEV2) | Response: Create ticket

**Step 1: Check active connections**

```sql
SELECT usename, application_name, state, COUNT(*) as conn_count
FROM pg_stat_activity
GROUP BY usename, application_name, state
ORDER BY conn_count DESC;
```

**Step 2: Identify idle connections**

```sql
-- Connections idle > 30 min (potential leak):
SELECT pid, usename, application_name, state_change, state
FROM pg_stat_activity
WHERE state = 'idle' AND state_change < now() - interval '30 minutes';

-- Terminate if safe:
-- SELECT pg_terminate_backend(pid) WHERE state = 'idle' ...
```

**Step 3: Check transaction durations**

```sql
-- Long-running transactions lock resources:
SELECT pid, usename, query_start, state, query
FROM pg_stat_activity
WHERE state = 'active' AND query_start < now() - interval '5 minutes';

-- Terminate if safe:
-- SELECT pg_terminate_backend(pid);
```

**Rollback steps:**

1. Increase pool size (if safe):
   ```bash
   DATABASE_POOL_MAX=50  # Increase from default
   ```
2. Restart backend service to reset connection pool
3. Monitor for connection leak; if persists, escalate to engineering

---

### Bulk Verification Failure Rate High

**Alert:** `BulkVerificationFailureRate` (SEV2) | Response: Create ticket

**Step 1: Check for missing indexes**

```sql
-- After a schema migration, check index status:
SELECT schemaname, tablename, indexname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE idx_scan = 0
LIMIT 20;
```

**Step 2: Examine verification logs**

```bash
# Filter logs for verification errors:
docker compose logs backend --tail=1000 | grep -i "verification\|verify.*fail"

# Look for patterns:
# - Timeout errors → Check [Timeout Budgets](docs/timeouts-and-retries.md)
# - Index not found → Re-run migrations
# - Batch too large → Reduce batch size in request
```

**Step 3: Check external dependency timeout**

```bash
# If timeouts spike during peak load:
# Check TIMEOUT_SOROBAN_MS or TIMEOUT_HTTP_MS settings
echo $TIMEOUT_SOROBAN_MS
echo $TIMEOUT_HTTP_MS

# Increase temporarily:
TIMEOUT_SOROBAN_MS=10000  # Increase from default 5000
```

**Rollback steps:**

1. Roll back the most recent schema migration:
   ```bash
   npm run migrate:down
   ```
2. If that doesn't work, check [Backup/Restore](#postgresql-down) procedures
3. Escalate to engineering if verification logic changed

---

### Lock Timeouts

**Alert:** Application logs show `TIMEOUT: lock_timeout exceeded` (SEV2)

**What it means:** A query tried to acquire a row or advisory lock but timed out waiting. This indicates lock contention.

**Step 1: Identify the blocker**

```sql
-- Find blocking and blocked queries:
SELECT
  blocked_locks.pid AS blocked_pid,
  blocked_activity.query AS blocked_query,
  blocked_activity.usename AS blocked_user,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.query AS blocking_query,
  blocking_activity.usename AS blocking_user
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
  AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
  AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
  AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
  AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
  AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
  AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
  AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
  AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid;
```

**Step 2: Check lock timeout configuration**

```bash
# Current setting:
echo $DATABASE_LOCK_TIMEOUT_MS

# If set too low (< 500ms), increase it:
DATABASE_LOCK_TIMEOUT_MS=2000  # 2 seconds
```

**See also:** [Lock Timeout Configuration](docs/lock-timeout-configuration.md)

**Rollback steps:**

1. Increase `DATABASE_LOCK_TIMEOUT_MS` temporarily to reduce incidents
2. Terminate the blocking query if it's safe and not serving requests
3. Implement row-level locking strategy in code (not in DB) if pattern persists

---

## Escalation

**When to escalate:**

- **SEV1 alert with no obvious cause** → Page on-call engineer
- **Database is down** → Page infrastructure team
- **Persistent connection pool saturation** → Page backend engineer
- **Verification failure after rollback** → Escalate to platform team

**Escalation path:**

1. **Page:** Use PagerDuty to wake on-call engineer
2. **Context:** Include health check output, Prometheus screenshot, and last 50 lines of logs
3. **Mention:** Any recent deployments or configuration changes

---

## Pre-Incident Checklist

Before going on-call, ensure:

- [ ] You can SSH/exec into the pod/container
- [ ] You have read access to PostgreSQL
- [ ] You have Redis credentials
- [ ] You can query Prometheus (or know how to access Grafana)
- [ ] You've read [Alert Routing](docs/alert-routing.md)
- [ ] You've skimmed [Graceful Shutdown](docs/graceful-shutdown.md)
- [ ] You've read through the [Timeout Budgets](docs/timeouts-and-retries.md) section

---

## Recovery Procedures

### Full Service Restart (Last Resort)

```bash
# 1. Verify you have a recent backup
npm run drill:restore

# 2. Graceful shutdown (30s grace period)
# Service will drain in-flight work, close connections, and exit cleanly
kill -SIGTERM <pid>
# or in Kubernetes:
kubectl delete pod <pod-name>

# 3. Restart service
npm start
# or in Kubernetes:
kubectl rollout restart deployment/credence-backend

# 4. Verify health
curl -s http://localhost:3000/api/health | jq .
```

### Database Connection Pool Reset

```bash
# If connection pool is stuck (many idle connections):

# 1. Identify idle connections
psql "$DATABASE_URL" -c "
  SELECT pid FROM pg_stat_activity
  WHERE state = 'idle' AND query_start < now() - interval '1 hour'
"

# 2. Terminate idle connections (safe)
psql "$DATABASE_URL" -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE state = 'idle' AND query_start < now() - interval '1 hour'
"

# 3. Restart the backend service to reset pool
```

### Cache Clear (Emergency)

```bash
# Only if Redis is causing widespread issues:
redis-cli -u "$REDIS_URL" FLUSHALL

# Expected impact:
# - All cached data is lost
# - First requests will be slow (cache misses)
# - Cache will repopulate over ~5 minutes
```

---

## Related Documentation

- [Alert Routing](docs/alert-routing.md) — Severity levels and on-call escalation
- [Monitoring](docs/monitoring.md) — Metrics and health checks
- [Graceful Shutdown](docs/graceful-shutdown.md) — How the service shuts down cleanly
- [Timeouts and Retries](docs/timeouts-and-retries.md) — Timeout budgets for each dependency
- [Lock Timeout Configuration](docs/lock-timeout-configuration.md) — Lock-specific diagnostics
- [Backup/Restore](docs/backup-restore.md) — Weekly backup verify drill
- [Error Codes](docs/error-codes.md) — API error reference

---

## Notes for Future On-Call

Add observations and learnings here for the next on-call engineer:

- _2026-06-25_: Cache invalidation can lag by 1-2s under heavy load; not an error
- _To be filled in by next on-call_
