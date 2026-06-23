# Graceful Shutdown

On `SIGTERM` or `SIGINT` the Credence API drains in-flight work and releases
all shared resources before the process exits. This makes rolling deploys and
autoscale-down events boring: no half-processed payouts, no stuck advisory
locks, no dropped listener offsets.

## Shutdown sequence

The `GracefulShutdownManager` (implemented in `src/gracefulShutdown.ts`)
executes the following phases in order. Each phase is timed and recorded as a
Prometheus metric.

| # | Phase | What happens |
|---|-------|-------------|
| 1 | `server_close` | Express HTTP server stops accepting new connections. In-flight HTTP requests are allowed to complete. |
| 2 | `ws_drain` | All open WebSocket clients receive close code `1000` ("Server shutting down gracefully"). A 5-second hard-terminate kicks in for any client that does not acknowledge. |
| 3 | `listener_stop` | Horizon event-listener consumer is stopped at its current offset, preventing reprocessing on restart. |
| 4 | `scheduler_drain` | The interval is cleared (no new job fires). If a job invocation is currently executing the coordinator polls `isJobRunning()` every 100 ms until the job finishes or the job drain window expires (see configuration). |
| 5 | `outbox_stop` | The outbox publisher is stopped. Any in-flight webhook delivery that is already acknowledged by the downstream is committed; un-acknowledged items remain `pending` for the next boot. |
| 6 | `invalidation_bus_stop` | The PostgreSQL LISTEN connection used for cross-replica cache invalidation is closed. |
| 7 | `pool_close` | All three pg pools (primary, worker, replica) are drained with `pool.end()`. |
| 8 | `redis_close` | The Redis client is disconnected with `QUIT`. |

If every phase completes within the grace period the process exits with code 0.

## Grace period and force-exit

A configurable force-exit timer starts the moment the signal arrives. If the
drain is not complete by the deadline the coordinator:

1. Destroys all tracked TCP sockets.
2. Calls `process.exit(1)`.
3. Logs `[Shutdown] Grace period expired — forcing exit.`
4. Increments the `shutdown_force_exit_total` metric.

Set the grace period via the `SHUTDOWN_GRACE_PERIOD_MS` environment variable
(default: 30 000 ms).

The job drain window is bounded separately by `jobDrainTimeoutMs` (default:
`min(0.7 × gracePeriodMs, 10 000 ms)`). A job that exceeds its window is
abandoned — the scheduler's interval has already been cleared so no new
invocations will fire, and the job itself is responsible for safe partial
commit if it is interruptible.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SHUTDOWN_GRACE_PERIOD_MS` | `30000` | Maximum ms before force-exit fires. |

`jobDrainTimeoutMs` is derived automatically from `gracePeriodMs`; it is not
currently exposed as an environment variable.

## Prometheus metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `shutdown_total` | Counter | `signal` | Incremented when a shutdown is initiated. |
| `shutdown_force_exit_total` | Counter | — | Incremented when the grace period fires. |
| `shutdown_phase_duration_seconds` | Histogram | `phase` | Duration of each shutdown phase. |

Useful PromQL:

```promql
# Force-exits over time
rate(shutdown_force_exit_total[5m])

# 99th-percentile drain time for the scheduler phase
histogram_quantile(0.99, rate(shutdown_phase_duration_seconds_bucket{phase="scheduler_drain"}[10m]))
```

## Double-signal handling

If a second `SIGTERM`/`SIGINT` arrives while a shutdown is already in
progress the coordinator calls `process.exit(1)` immediately and increments
`shutdown_force_exit_total`. This mirrors the behaviour expected by container
runtimes that send `SIGTERM` then `SIGKILL`.

## Architecture notes

```
SIGTERM / SIGINT
      │
      ▼
GracefulShutdownManager.shutdown(signal)
      │
      ├─ server.close()         ← stops accepting HTTP/WS upgrades
      ├─ drainWebSockets()      ← close(1000) + 5s terminate fallback
      ├─ stopListeners()        ← Horizon consumer offset commit
      ├─ drainScheduler()       ← stop() + poll isJobRunning()
      ├─ outboxJob.stop()       ← flush in-flight webhook deliveries
      ├─ invalidationBus.stop() ← close PG LISTEN connection
      ├─ pool.end() × 3         ← drain pg connection pools
      └─ redis.disconnect()     ← QUIT Redis
```

The distributed lock (`DistributedLock`) does not need explicit shutdown
handling: locks are acquired with a TTL and the heartbeat timer is cleared in
the `finally` block of `withLock()`. As long as the job itself is allowed to
finish (via the scheduler drain phase) the lock is released atomically before
the process exits.

## Testing

```bash
# Run the shutdown coordinator tests
npm run test -- gracefulShutdown

# Coverage report
npm run test:coverage
```

The test suite covers:

- Clean shutdown path (all phases complete within grace period → exit 0)
- In-flight job drains before exit
- WS clients receive close code 1000
- WS clients that ignore close are terminated after 5 s
- DB pools and Redis are closed
- Pool/Redis errors are tolerated (shutdown continues)
- Force-exit when grace period expires (exit 1 + metric)
- Double-signal triggers immediate force-exit
- SIGTERM arriving before HTTP server is ready

## Operational runbook

### Rolling deploy (Kubernetes)

The default `terminationGracePeriodSeconds` in the pod spec should be at
least `SHUTDOWN_GRACE_PERIOD_MS / 1000 + 5` seconds to give the coordinator
time to finish before the kubelet sends `SIGKILL`.

```yaml
spec:
  terminationGracePeriodSeconds: 40   # 30 s grace + 10 s buffer
```

### Diagnosing force-exit alerts

1. Check `shutdown_phase_duration_seconds_bucket` to identify the slow phase.
2. If `scheduler_drain` is the culprit, the in-flight job exceeded its drain
   window. Inspect the job logs for the root cause (long query, external call
   timeout, etc.).
3. If `outbox_stop` is slow, check the outbox publisher delivery queue depth
   and downstream webhook response times.
4. Increase `SHUTDOWN_GRACE_PERIOD_MS` as a short-term mitigation while
   diagnosing the underlying issue.
