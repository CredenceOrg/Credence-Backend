# OBSERVABILITY — Metrics & Dashboards

> **Audience: operators.** This is the single reference index for what the
> Credence Backend exposes through Prometheus, what the Grafana dashboard
> shows, and which PromQL queries back the alert rules.
>
> If you are looking for **request tracing, log redaction, or the JSON log
> schema**, see [`docs/observability.md`](./observability.md).
> If you are wiring up the monitoring stack from scratch, see
> [`docs/monitoring.md`](./monitoring.md).

---

## 1. Where the data comes from

### 1.1 Scrape endpoint

The backend exposes Prometheus exposition format at:

```
GET /metrics
```

The endpoint is **unauthenticated by design** (Prometheus does not send auth
headers) but is CIDR-restricted by the `METRICS_ALLOWED_CIDRS` environment
variable. See [`docs/monitoring.md`](./monitoring.md#metrics-endpoint-security)
for the full security model.

A real (truncated) scrape against a local backend:

```bash
$ curl -sS http://localhost:3000/metrics | head -n 25
# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/health",status="200"} 412
http_requests_total{method="GET",route="/api/health",status="304"} 12
http_requests_total{method="POST",route="/api/attestations",status="201"} 7
# HELP http_request_duration_seconds HTTP request latency in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/api/health",status_class="2xx",le="0.005"} 321
http_request_duration_seconds_bucket{method="GET",route="/api/health",status_class="2xx",le="0.01"} 389
http_request_duration_seconds_bucket{method="GET",route="/api/health",status_class="2xx",le="0.025"} 410
http_request_duration_seconds_bucket{method="GET",route="/api/health",status_class="2xx",le="+Inf"} 412
http_request_duration_seconds_count{method="GET",route="/api/health",status_class="2xx"} 412
http_request_duration_seconds_sum{method="GET",route="/api/health",status_class="2xx"} 1.823
# HELP health_check_status Health check status (1 = up, 0 = down)
# TYPE health_check_status gauge
health_check_status{dependency="db"} 1
health_check_status{dependency="redis"} 1
```

`route` is always the **normalized template** (e.g. `/api/trust/:address`),
never the raw path with a real address — see [`docs/sla-metrics.md`](./sla-metrics.md#cardinality-policy)
for the cardinality policy.

### 1.2 Scrape configuration

`monitoring/prometheus/prometheus.yml` scrapes every 10 s:

```yaml
scrape_configs:
  - job_name: 'credence-backend'
    static_configs:
      - targets: ['host.docker.internal:3000']
        labels:
          service: 'api'
          tier: 'backend'
    metrics_path: '/metrics'
    scrape_interval: 10s
    scrape_timeout: 5s
```

Alert rules are loaded from `monitoring/prometheus/alerts.yml` and routed by
`monitoring/prometheus/alertmanager.yml` (severity-driven — see
[`docs/alert-routing.md`](./alert-routing.md)).

### 1.3 What gets registered

All metrics in this document are registered on the `prom-client` Registry
created in [`src/middleware/metrics.ts`](../src/middleware/metrics.ts), with
two exceptions:

* `nodejs_*` — the standard default metrics (`process_cpu_user_seconds_total`,
  `nodejs_eventloop_lag_seconds`, …) added by
  `client.collectDefaultMetrics({ register, prefix: 'nodejs_' })`.
* Per-worker metrics (`outbox_*`, `notification_*`, the lazy retry observer)
  registered on the **default** `prom-client` global registry because they
  are added to components that have no `register` argument available.

---

## 2. Grafana dashboard

* **Title:** `Credence Backend - API Monitoring`
* **UID:** `credence-backend-dashboard`
* **Source:** [`monitoring/grafana/dashboard.json`](../monitoring/grafana/dashboard.json)
* **Provisioning:** [`monitoring/grafana/provisioning/dashboards/dashboard.yml`](../monitoring/grafana/provisioning/dashboards/dashboard.yml)
  reads dashboards from the provisioning directory at 10 s intervals.
* **Data source:** `Prometheus` (auto-provisioned via
  [`monitoring/grafana/provisioning/datasources/prometheus.yml`](../monitoring/grafana/provisioning/datasources/prometheus.yml))
* **Refresh:** `10s`; default range `now-1h → now`.

### 2.1 Panels (verbatim from `dashboard.json`)

The actual panel layout — title, panel id, grid position, and the PromQL that
runs on the production dashboard. Every query below is exactly what
Grafana ships today; if you change a metric name in code, you also need
to update the matching query here.

| Panel ID | Title                             | Grid (w×h @ x,y) | PromQL (verbatim from `dashboard.json`)                                                                                                                  |
| -------- | --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | HTTP Error Rate (5xx)             | 6×8 @ (0,0)      | `rate(http_requests_total{job="credence-backend", status=~"5.."}[5m]) / rate(http_requests_total{job="credence-backend"}[5m])`                         |
| 2        | HTTP Request Rate                 | 9×8 @ (6,0)      | `rate(http_requests_total{job="credence-backend"}[5m])`                                                                                                 |
| 3        | HTTP Request Latency (p50/p95/p99)| 9×8 @ (15,0)     | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="credence-backend"}[5m]))` (and 0.95 / 0.50 variants)                        |
| 4        | HTTP Status Codes Distribution    | 12×8 @ (0,8)     | `rate(http_requests_total{job="credence-backend"}[5m])`                                                                                                 |
| 5        | Database Health                   | 6×8 @ (12,8)     | `health_check_status{job="credence-backend", dependency="db"}`                                                                                          |
| 6        | Redis Health                      | 6×8 @ (18,8)     | `health_check_status{job="credence-backend", dependency="redis"}`                                                                                       |
| 7        | Health Check Duration             | 12×8 @ (0,16)    | `health_check_duration_seconds{job="credence-backend", dependency="db"}` / `…dependency="redis"`                                                         |
| 8        | Business Metrics – Operations Rate| 12×8 @ (12,16)   | `rate(reputation_score_calculations_total{…}[5m])` / `rate(identity_verifications_total{…}[5m])` / `rate(bulk_verifications_total{…}[5m])`            |
| 9        | Business Operations Duration (p95)| 12×8 @ (0,24)    | `histogram_quantile(0.95, rate(reputation_calculation_duration_seconds_bucket{…}[5m]))` / `histogram_quantile(0.95, rate(identity_sync_duration_seconds_bucket{…}[5m]))` |
| 10       | Avg Bulk Verification Batch Size  | 6×8 @ (12,24)    | `avg(bulk_verification_batch_size{job="credence-backend"})`                                                                                             |
| 11       | Total Verifications (24h)         | 6×8 @ (18,24)    | `sum(increase(identity_verifications_total{job="credence-backend"}[24h]))`                                                                              |
| 12       | Outbox Published/Failed           | 12×8 @ (0,32)    | `rate(outbox_published_total[5m])` and `rate(outbox_failed_total[5m])`                                                                                  |
| 13       | Outbox Pending Events             | 6×8 @ (12,32)    | `outbox_pending_gauge`                                                                                                                                  |
| 14       | Outbox Lease Renewals             | 6×8 @ (18,32)    | `rate(outbox_lease_renew_total[5m])`                                                                                                                    |
| 15       | Horizon Listener Lag (seconds)    | 12×8 @ (0,40)    | `horizon_listener_lag_seconds` and `horizon_listener_lease_ttl_seconds` (see Note below)                                                              |
| 16       | Horizon Listener — Active Owner & Fencing Token | 12×8 @ (12,40) | `horizon_listener_fencing_token` (see Note below)                                                                              |

> **Note (panels 15 & 16):** these two panels ship in the dashboard but
> query `horizon_listener_lag_seconds`, `horizon_listener_lease_ttl_seconds`,
> and `horizon_listener_fencing_token`, which are **not** emitted from any
> source file in this codebase today. Today the backend emits
> `horizon_listener_cursor_lag_seconds` and
> `horizon_listener_last_checkpoint_timestamp` from
> [`src/listeners/horizonBondEvents.ts`](../src/listeners/horizonBondEvents.ts)
> and [`src/listeners/horizonWithdrawalEvents.ts`](../src/listeners/horizonWithdrawalEvents.ts);
> the HA lag / fencing-token gauges are a known dashboard gap to close when
> the standby listener is implemented.

### 2.2 SLA table panel

```promql
sum(rate(http_request_duration_seconds_bucket{le="0.25", status_class="2xx"}[5m])) by (route)
/
sum(rate(http_request_duration_seconds_count{status_class="2xx"}[5m])) by (route)
```

Thresholds: green ≥ 0.95, yellow ≥ 0.90, red < 0.90.

### 2.3 Importing the dashboard locally

* The **SLA Compliance: % Requests < 250ms (Success Only)** table is also
  rendered on this dashboard. It is documented separately in §2.2 below
  (it shares `id:12` with the Outbox Published/Failed panel due to a
  duplication in the on-disk JSON — refer to it by title, not by id).

* `monitoring/grafana/dashboard.json` actually contains a **16th and 17th
  panel** for HA-listener fencing tokens whose underlying metrics are not
  yet emitted from source. They are listed as panels 15 and 16 in §2.1 with
  a Note so operators can reconcile the doc with the dashboard.
For a one-off import through the UI:

```bash
# 1. Start the stack (API + Postgres + Redis + Prometheus + Grafana)
docker compose up -d prometheus grafana

# 2. Open Grafana UI
open http://localhost:3001         # admin / admin by default

# 3. Dashboards → New → Import → upload monitoring/grafana/dashboard.json
#    Select the Prometheus datasource, click Import.
```

For production, ship the same JSON via a `ConfigMap` —
see [`docs/monitoring.md#deployment`](./monitoring.md#deployment).

---

## 3. Metric catalogue

Every `prom-client` metric the backend emits, grouped by domain. For each
entry: type, labels, where the metric is defined, and the call site that
updates it. Use the **name** column when grepping the dashboard JSON or
Prometheus alerts.

### 3.1 HTTP API

| Name                               | Type       | Labels                          | Defined in                                                  | Updated from                                                                                |
| ---------------------------------- | ---------- | ------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `http_requests_total`              | Counter    | `method`, `route`, `status`     | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | `metricsMiddleware()` on `res.on('finish')`                                                 |
| `http_requests_status_total`       | Counter    | `method`, `route`, `status_class`| [`src/observability/latencyMetrics.ts`](../src/observability/latencyMetrics.ts) | same middleware; status_class = `${floor(code/100)}xx`                                     |
| `http_request_duration_seconds`    | Histogram  | `method`, `route`, `status_class`| [`src/observability/latencyMetrics.ts`](../src/observability/latencyMetrics.ts) | same middleware; buckets tuned for the 250 ms SLO target                                   |
| `http_response_size_bytes`         | Histogram  | `compressed`                    | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | [`src/middleware/compression.ts`](../src/middleware/compression.ts)                         |

`route` is normalized to a template by `normalizeRoute()` in
[`src/observability/latencyMetrics.ts`](../src/observability/latencyMetrics.ts)
— e.g. `/api/trust/GAAAA…` becomes `/api/trust/:address`. This keeps total
cardinality bounded around ~2,500 series.

### 3.2 Dependency health

| Name                            | Type  | Labels       | Defined in                                                  | Updated from                                                                                          |
| ------------------------------- | ----- | ------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `health_check_status`           | Gauge | `dependency` | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | `recordHealthCheck(dependency, isUp, ms)` — called by the health probes (`db`, `redis`, …)            |
| `health_check_duration_seconds` | Gauge | `dependency` | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | same                                                                                                  |

The Grafana gauges **Database Health** and **Redis Health** map
`health_check_status{dependency="db"}` and `…="redis"` to a binary Up/Down
status.

### 3.3 Business — verification & reputation

| Name                                       | Type      | Labels                | Defined in                                                  | Updated from                                                                                            |
| ------------------------------------------ | --------- | --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `reputation_score_calculations_total`     | Counter   | —                     | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | `recordReputationCalculation(durationMs)`                                                              |
| `reputation_calculation_duration_seconds`  | Histogram | —                     | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | same                                                                                                    |
| `identity_verifications_total`             | Counter   | `status` (`success`/`error`)| same                                                    | `recordIdentityVerification(status)`                                                                   |
| `bulk_verifications_total`                 | Counter   | `status`              | same                                                        | `recordBulkVerification(batchSize, status)`                                                            |
| `bulk_verification_batch_size`             | Histogram | —                     | same                                                        | same                                                                                                    |
| `bulk_queue_wait_seconds`                  | Histogram | `org_id`              | same                                                        | [`src/jobs/bulkWorker.ts`](../src/jobs/bulkWorker.ts) on each job pickup                                 |
| `identity_sync_duration_seconds`           | Histogram | `operation` (`reconcile`/`full_resync`)| same                                      | `recordIdentitySync(operation, ms)`                                                                    |
| `stale_cache_reads_total`                  | Counter   | `namespace`           | same                                                        | `recordStaleCacheRead(namespace)` (e.g. `transaction_status` after a write txn)                          |

### 3.4 Idempotency & settlement

| Name                                       | Type    | Labels                                  | Defined in                                                  | Updated from                                                                                            |
| ------------------------------------------ | ------- | --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `idempotency_guard_checks_total`           | Counter | `handler_type`, `result`                | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | `recordIdempotencyCheck(handlerType, 'duplicate'|'executed'|'error')`                                   |
| `idempotency_duplicates_detected_total`    | Counter | `handler_type`                          | same                                                        | same, on `result === 'duplicate'`                                                                      |
| `settlement_duplicates_detected_total`     | Counter | —                                       | same                                                        | `recordSettlementDuplicate()` from settlement service; collapse-on-`transaction_hash`                   |
| `settlement_drift_total`                   | Counter | `finding_type` (`state_mismatch`/`missing_on_chain`) | same                                              | `recordSettlementDrift(findingType)` from [`src/jobs/settlementReconciler.ts`](../src/jobs/settlementReconciler.ts) |
| `settlement_unmatched_count`               | Gauge   | —                                       | same                                                        | `setSettlementUnmatchedCount(count)` — set at the end of each reconciliation run                       |

### 3.5 Webhooks & DLQ

| Name                | Type  | Labels | Defined in                                                  | Updated from                                                                                            |
| ------------------- | ----- | ------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `webhook_dlq_size`  | Gauge | —      | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts) | `recordWebhookDlqSize(size)` from [`src/services/webhooks/postgresDlqStore.ts`](../src/services/webhooks/postgresDlqStore.ts) |
| `outbox_dead_letter_total`     | Counter | `error_code` | [`src/observability/outboxMetrics.ts`](../src/observability/outboxMetrics.ts)            | `incrementOutboxDeadLetter(errorCode)`                                                      |
| `outbox_quarantine_total`      | Counter | `reason`     | same                                                                                       | `incrementOutboxQuarantine(reason)`                                                          |

### 3.6 Outbox publisher

All defined in [`src/observability/outboxMetrics.ts`](../src/observability/outboxMetrics.ts).

| Name                         | Type    | Labels          | Updated from                                                                                            |
| ---------------------------- | ------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| `outbox_published_total`     | Counter | `aggregate_type`| `incrementOutboxPublished(aggregateType)` after a successful event post                                 |
| `outbox_failed_total`        | Counter | `aggregate_type`| `incrementOutboxFailed(aggregateType)` on a failed publish attempt                                       |
| `outbox_pending_gauge`       | Gauge   | —               | `setOutboxPendingGauge(count)` at the end of each publisher loop (see [`src/db/outbox/publisher.ts`](../src/db/outbox/publisher.ts)) |
| `outbox_lease_renew_total`   | Counter | —               | `incrementOutboxLeaseRenew(count)` while a worker holds a lease                                         |

### 3.7 Notifications

All defined in [`src/services/notifications/promMetrics.ts`](../src/services/notifications/promMetrics.ts).

| Name                                       | Type    | Labels                                       | Updated from                                                                                            |
| ------------------------------------------ | ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `notification_provider_attempts_total`    | Counter | `provider`, `outcome`                        | `recordNotificationProviderAttempt(provider, outcome)`                                                  |
| `notification_provider_success_total`      | Counter | `provider`                                   | `recordNotificationProviderSuccess(provider)`                                                          |
| `notification_failovers_total`             | Counter | `from_provider`, `to_provider`               | `recordNotificationFailover(from, to)`                                                                  |
| `notification_dlq_total`                   | Counter | `reason`                                     | `recordNotificationDlq(reason)`                                                                         |

A separate, name-stable `# HELP` exposition for the same counters (kept for
backwards compatibility with the legacy `metricsToPrometheus()` text format)
is rendered in [`src/services/notifications/metrics.ts`](../src/services/notifications/metrics.ts).

### 3.8 Outbound retry & RPC

| Name                                       | Type      | Labels                          | Defined in                                                                                              | Updated from                                                                                            |
| ------------------------------------------ | --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `outbound_retry_attempts_total`            | Counter   | `provider`, `error_code`         | [`src/observability/retryMetrics.ts`](../src/observability/retryMetrics.ts) — lazy-instantiated singleton | `RetryObserver.onRetryAttempt` events emitted by retry-aware clients (Soroban, webhooks)              |
| `outbound_retry_exhausted_total`           | Counter   | `provider`, `error_code`         | same                                                                                                   | `RetryObserver.onRetryExhausted` events                                                                |
| `outbound_retry_delay_milliseconds`        | Histogram | `provider`                      | same                                                                                                   | same (records scheduled backoff delay)                                                                 |
| `outbound_call_duration_milliseconds`      | Histogram | `provider`, `outcome` (`first_try`/`retried`) | same                                                                                          | `RetryObserver.onSuccess` events (total wall-clock duration including retries)                         |
| `downstream_rpc_latency_milliseconds`      | Histogram | `provider`, `op`                | [`src/observability/rpcLatencyMetrics.ts`](../src/observability/rpcLatencyMetrics.ts)                   | `recordDownstreamRpcLatency(provider, op, ms)` — currently emitted for Soroban RPC calls              |

### 3.9 Soroban client

| Name                                  | Type    | Labels                       | Defined in                                                                                              | Updated from                                                                                            |
| ------------------------------------- | ------- | ---------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `soroban_circuit_state`               | Gauge   | `host`                       | [`src/clients/circuitBreaker.ts`](../src/clients/circuitBreaker.ts); values `0=CLOSED`, `1=OPEN`, `2=HALF_OPEN` | `CircuitBreaker.transitionTo(state)`                                                                   |
| `soroban_state_cache_hits_total`      | Counter | `network`, `contract`        | [`src/clients/sorobanStateCache.ts`](../src/clients/sorobanStateCache.ts)                               | on every `SorobanStateCache.get()` L1 or L2 hit                                                          |
| `soroban_state_cache_misses_total`    | Counter | `network`, `contract`        | same                                                                                                   | on every `SorobanStateCache.get()` miss (and on `disabled` requests)                                   |

### 3.10 Horizon listener

`horizon_reconnect_total` and `horizon_stream_up` are factory-built on first
use from [`src/observability/horizonMetrics.ts`](../src/observability/horizonMetrics.ts)
and shared by both listeners.

| Name                                              | Type    | Labels        | Defined in                                                                                                                  | Updated from                                                                                            |
| ------------------------------------------------- | ------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `horizon_reconnect_total`                         | Counter | `stream`      | [`src/observability/horizonMetrics.ts`](../src/observability/horizonMetrics.ts) (`getHorizonMetrics()`)                     | both listeners, in their `onerror` reconnect path                                                       |
| `horizon_stream_up`                               | Gauge   | `stream`      | same                                                                                                                       | `streamUp.set({stream},1)` on connect, `set(...,0)` on error or `stop()`                                |
| `horizon_listener_cursor_lag_seconds`             | Gauge   | `stream_name` | [`src/listeners/horizonBondEvents.ts`](../src/listeners/horizonBondEvents.ts); reused by [`src/listeners/horizonWithdrawalEvents.ts`](../src/listeners/horizonWithdrawalEvents.ts) | `updateMetrics(cursorRepo)` after every successful cursor checkpoint                                    |
| `horizon_listener_last_checkpoint_timestamp`      | Gauge   | `stream_name` | same                                                                                                                       | same                                                                                                    |

Active stream names today: `bond_creation`, `bond_withdrawal`.

### 3.11 PostgreSQL pool & advisory locks

| Name                              | Type  | Labels                                        | Defined in                                                                                              | Updated from                                                                                            |
| --------------------------------- | ----- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pg_pool_total_count`             | Gauge | `pool` (`api`/`worker`)                       | [`src/observability/poolMetrics.ts`](../src/observability/poolMetrics.ts)                               | `collect()` callback sampling `pool.totalCount` at scrape time                                          |
| `pg_pool_idle_count`              | Gauge | `pool`                                        | same                                                                                                   | same, `pool.idleCount`                                                                                 |
| `pg_pool_waiting_count`           | Gauge | `pool`                                        | same                                                                                                   | same, `pool.waitingCount`                                                                              |
| `pg_advisory_lock_age_seconds`    | Gauge | `lock_id`, `pid`, `database`, `query`         | [`src/jobs/advisoryLockMonitor.ts`](../src/jobs/advisoryLockMonitor.ts)                                 | `collectStaleAdvisoryLocks(pool)` populates one sample per lock held > 300 s                          |

### 3.12 Database transactions & WebSocket

| Name                             | Type      | Labels | Defined in                                                                | Updated from                                                                                            |
| -------------------------------- | --------- | ------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `db_txn_duration_seconds`        | Histogram | —      | [`src/observability/customMetrics.ts`](../src/observability/customMetrics.ts) | observed by [`src/db/TransactionManager.withTransaction`](../src/db/transaction.js) (every wrapped txn) |
| `db_txn_savepoints`              | Histogram | —      | same                                                                      | same                                                                                                    |
| `ws_evicted_slow_consumers_total`| Counter   | —      | same                                                                      | incremented whenever a WebSocket subscriber is backpressured above the high-water mark                  |

### 3.13 Analytics & caches

| Name                                           | Type      | Labels                | Defined in                                                                                              | Updated from                                                                                            |
| ---------------------------------------------- | --------- | --------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `trust_score_cache_hits_total`                 | Counter   | —                     | [`src/services/reputationService.ts`](../src/services/reputationService.ts)                             | `getTrustScore()` Redis hit                                                                              |
| `trust_score_cache_misses_total`               | Counter   | —                     | same                                                                                                   | same, on Redis miss                                                                                     |
| `analytics_cache_hits_total`                  | Counter   | —                     | [`src/routes/analytics.ts`](../src/routes/analytics.ts)                                                | `/api/analytics/summary` Redis hit                                                                       |
| `analytics_cache_misses_total`                | Counter   | —                     | same                                                                                                   | same, on Redis miss                                                                                     |
| `analytics_refresh_runs_total`                | Counter   | `status` (`success`/`error`) | [`src/jobs/analyticsRefreshMetrics.ts`](../src/jobs/analyticsRefreshMetrics.ts)                    | end of every `REFRESH MATERIALIZED VIEW CONCURRENTLY`                                                  |
| `analytics_refresh_duration_seconds`          | Histogram | —                     | same                                                                                                   | same                                                                                                    |
| `analytics_view_age_seconds`                  | Gauge     | —                     | same                                                                                                   | end of every successful refresh (snapshot age at the time of refresh)                                 |
| `analytics_scheduler_skips_total`             | Counter   | `reason` (`overlap`/`lock_contention`) | same                                                                          | scheduler skip on overlap or distributed lock contention                                                |

### 3.14 Evidence, credits, rate-limit, retries-shaping

| Name                                       | Type    | Labels                              | Defined in                                                                                              | Updated from                                                                                            |
| ------------------------------------------ | ------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `evidence_upload_accepted_total`           | Counter | —                                   | [`src/routes/evidence.ts`](../src/routes/evidence.ts)                                                   | `evidenceUploadAcceptedTotal.inc()` after a successful multer→storage write                              |
| `evidence_upload_rejected_total`           | Counter | `reason` (`invalid_extension`/`invalid_mime_type`/`magic_number_mismatch`/`file_too_large`/`too_many_files`/`field_too_large`/`no_files`/`empty_file`/`multer_error`/`storage_error`) | same                              | on every rejected upload, with the specific rejection cause                                              |
| `credits_low_events_total`                 | Counter | —                                   | [`src/observability/creditsMetrics.ts`](../src/observability/creditsMetrics.ts)                          | `recordCreditsLowEvent()` when an org crosses the low-water threshold                                  |
| `rate_limit_rejected_total`                | Counter | `tier`, `key_id`, `reason` (`tenant_limit`/`key_limit`/`redis_unavailable`) | [`src/middleware/rateLimit.ts`](../src/middleware/rateLimit.ts)                | `createRateLimitMiddleware` reject path                                                                 |
| `rate_limit_hits_total`                    | Counter | `tenant`, `tier`                    | same                                                                                                   | every successful rate-limit check, plus every reject                                                    |

### 3.15 Background jobs & housekeeping

| Name                                                     | Type      | Labels       | Defined in                                                                                                        | Updated from                                                                              |
| -------------------------------------------------------- | --------- | ------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `synthetic_probe_success_total`                          | Counter   | —            | [`src/observability/customMetrics.ts`](../src/observability/customMetrics.ts)                                     | synthetic end-to-end probe, on pass                                                     |
| `synthetic_probe_failure_total`                          | Counter   | `step`       | same                                                                                                              | synthetic probe, on failure labelled by step                                              |
| `webhook_payload_bytes`                                  | Histogram | `subscriber` | same                                                                                                              | on every outgoing webhook (per receiving subscriber)                                      |
| `audit_chain_integrity_violation_total`                  | Counter   | —            | [`src/jobs/auditChainMetrics.ts`](../src/jobs/auditChainMetrics.ts)                                                | `PrometheusAuditChainMetrics.incViolation()` on a tamper-detection finding                |
| `audit_chain_verifier_rows_checked`                      | Gauge     | —            | same                                                                                                              | `setRowsChecked(n)` at the end of every verifier run                                       |
| `audit_chain_verifier_last_run_timestamp`                | Gauge     | —            | same                                                                                                              | `setLastRunTimestamp(ms)` — unix seconds                                                  |
| `audit_chain_verifier_last_run_valid`                    | Gauge     | —            | same                                                                                                              | `setLastRunValid(boolean)` (1 = pass, 0 = break)                                           |
| `failed_inbound_sweeper_runs_total`                      | Counter   | —            | [`src/jobs/failedInboundEventsSweeperMetrics.ts`](../src/jobs/failedInboundEventsSweeperMetrics.ts)                | `incRuns()` end of every sweeper invocation                                               |
| `failed_inbound_sweeper_duration_seconds`                | Histogram | —            | same                                                                                                              | `observeDuration(seconds)`                                                               |
| `failed_inbound_swept_total`                             | Counter   | —            | same                                                                                                              | `incSwept(count)` (terminal events removed)                                                |
| `failed_inbound_retained_total`                          | Counter   | —            | same                                                                                                              | `setRetained(count)` (events still within retention window)                                |
| `backup_restore_verify_seconds`                          | Histogram | —            | [`src/jobs/backupVerifyMetrics.ts`](../src/jobs/backupVerifyMetrics.ts)                                            | `observeDuration(seconds)` on each backup-restore-verify invocation                       |
| `backup_restore_failed_total`                            | Counter   | `step`       | same                                                                                                              | `incFailure(step)` on failure                                                             |
| `shutdown_phase_duration_seconds`                        | Histogram | `phase`       | [`src/observability/shutdownMetrics.ts`](../src/observability/shutdownMetrics.ts)                                  | `ShutdownMetrics.observePhase(phase, s)` per phase of graceful shutdown                  |
| `shutdown_total`                                         | Counter   | `signal`      | same                                                                                                              | `incShutdown(signal)` when the coordinator kicks in                                       |
| `shutdown_force_exit_total`                              | Counter   | —             | same                                                                                                              | `incForceExit()` after `SHUTDOWN_GRACE_PERIOD_MS` elapses                                   |
| `oom_events_total`                                       | Counter   | —             | [`src/middleware/metrics.ts`](../src/middleware/metrics.ts)                                                        | `recordOomEvent()` from signal handler                                                  |

### 3.16 Default Node.js metrics

`client.collectDefaultMetrics({ prefix: 'nodejs_' })` registers the standard
prom-client default metrics on the same registry. Examples operators look at:

| Name                            | Type    | What it answers                                                                                              |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `nodejs_cpu_user_seconds_total` | Counter | CPU time spent in user mode (per core).                                                                        |
| `nodejs_memory_rss_bytes`       | Gauge   | Resident set size — useful for OOM trending. Source of the `oom_events_total` alert threshold when paired.   |
| `nodejs_eventloop_lag_seconds`  | Gauge   | Event loop lag. > 1 s sustained indicates the process is CPU-starved.                                          |
| `nodejs_heap_size_total_bytes`  | Gauge   | Total V8 heap size. Compare with `nodejs_heap_used_bytes` to spot fragmentation/leak.                         |
| `nodejs_active_handles_total`   | Gauge   | Open libuv handles (sockets, timers, …). Sustained growth without traffic implies leaks.                       |
| `nodejs_active_requests_total`  | Gauge   | Open in-flight requests at the libuv layer.                                                                  |

---

## 4. Real examples

Every command in this section is runnable against a live backend. Use them
as-is when triaging an incident.

### 4.1 Are metrics being scraped?

```bash
# Prometheus targets page (UI)
open http://localhost:9090/targets

# Confirm backend is exposing /metrics
curl -sf http://localhost:3000/metrics | head -n 5

# Confirm a known metric name appears (exit 0 = yes)
curl -sf http://localhost:3000/metrics | grep -q '^http_requests_total{' && echo OK
```

### 4.2 Is the database healthy?

```bash
# From Prometheus: confirm gauge is 1 across the last 5 minutes
curl -sG http://localhost:9090/api/v1/query \
  --data-urlencode 'query=avg_over_time(health_check_status{dependency="db"}[5m])'
```

### 4.3 What is the current p95 latency on `/api/trust/:address`?

```promql
histogram_quantile(
  0.95,
  sum(rate(http_request_duration_seconds_bucket{route="/api/trust/:address", status_class="2xx"}[5m])) by (le)
)
```

### 4.4 Active alerts

```bash
curl -s http://localhost:9090/api/v1/alerts | jq '[.data.alerts[] | {name: .labels.alertname, severity: .labels.severity, since: .activeAt}]'
```

### 4.5 Top 5 routes by 5xx rate over the last 15 minutes

```promql
topk(5,
  sum(rate(http_requests_total{status=~"5.."}[15m])) by (route)
  /
  sum(rate(http_requests_total[15m])) by (route)
)
```

### 4.6 Outbox backlog growing?

```promql
# Backlog size right now
outbox_pending_gauge

# Publish rate minus failure rate over 5m (should be > 0)
sum(rate(outbox_published_total[5m])) - sum(rate(outbox_failed_total[5m]))
```

### 4.7 Soroban circuit-breaker state, by host

```promql
# 0 = CLOSED, 1 = OPEN, 2 = HALF_OPEN
max by (host) (soroban_circuit_state)
```

### 4.8 DB connection pool saturation

```promql
# Anything queued on the API pool?
pg_pool_waiting_count{pool="api"} > 0
```

---

## 5. Prometheus alerts

The full rule file is [`monitoring/prometheus/alerts.yml`](../monitoring/prometheus/alerts.yml).
Routing by severity lives in
[`monitoring/prometheus/alertmanager.yml`](../monitoring/prometheus/alertmanager.yml)
and [`docs/alert-routing.md`](./alert-routing.md). At a glance:

| Alert                              | Severity | Expression (snipped)                                                                                                    | Runbook                                           |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `SuccessRateSLOViolation`          | SEV1     | `sum(rate(...status_class="5xx"[5m])) / sum(rate(...[5m])) > 0.001`                                                      | `docs/SLO.md`                                     |
| `ErrorBudgetBurnRateHigh`          | SEV1     | `(...[1h]) / 0.001 > 2`                                                                                                  | `docs/SLO.md`                                     |
| `EndpointLatencySLOViolation`      | SEV2     | `sum(rate(...le="0.25",status_class="2xx"}[5m])) by (route) / sum(rate(...[5m])) by (route) < 0.95`                       | `docs/SLO.md`                                     |
| `HighP99Latency`                   | SEV2     | `histogram_quantile(0.99, sum(...[5m])) by (le, route) > 1`                                                              | `docs/SLO.md`                                     |
| `HighLatency`                      | SEV3     | `histogram_quantile(0.95, …) > 1`                                                                                        | `docs/SLO.md`                                     |
| `DatabaseDown`                     | SEV1     | `health_check_status{dependency="db"} == 0`                                                                              | `docs/monitoring.md`                              |
| `RedisDown`                        | SEV1     | `health_check_status{dependency="redis"} == 0`                                                                           | `docs/monitoring.md`                              |
| `SlowHealthCheck`                  | SEV3     | `health_check_duration_seconds{job="credence-backend"} > 3`                                                              | `docs/monitoring.md`                              |
| `LowVerificationRate`              | SEV2     | `rate(identity_verifications_total[10m]) < 0.1`                                                                          | —                                                 |
| `HighBulkVerificationFailureRate`  | SEV2     | `rate(…status="error"[5m]) / rate(…[5m]) > 0.1`                                                                          | —                                                 |
| `PgPoolSaturation`                 | SEV2     | `pg_pool_waiting_count{pool="api"} > 0` for 2 m                                                                           | `docs/monitoring.md`                              |
| `PgWorkerPoolSaturation`           | SEV3     | `pg_pool_waiting_count{pool="worker"} > 0` for 5 m                                                                       | `docs/monitoring.md`                              |
| `AuditChainIntegrityViolation`     | SEV1     | `audit_chain_integrity_violation_total > 0`                                                                              | `docs/audit-log.md`                               |
| `AuditChainVerifierStale`          | SEV2     | `time() - audit_chain_verifier_last_run_timestamp > 1800`                                                                | `docs/audit-log.md`                               |

Severity-driven routing means: **SEV1 in prod pages on-call**; SEV2/SEV3
become Slack tickets. See [`docs/alert-routing.md`](./alert-routing.md).

---

## 6. Related documentation

* [`docs/observability.md`](./observability.md) — request tracing, log
  schemas, PII redaction, db transaction spans, outbox publisher logging.
* [`docs/monitoring.md`](./monitoring.md) — installing the Prometheus +
  Grafana stack, dashboards, alerts, deployment (K8s).
* [`docs/SLO.md`](./SLO.md) — Service Level Objectives (99.9 % success,
  p95 < 250 ms, error-budget burn-rate).
* [`docs/sla-metrics.md`](./sla-metrics.md) — cardinality policy for the
  HTTP latency histograms.
* [`docs/alert-routing.md`](./alert-routing.md) — severity-aware Alertmanager
  routing (PagerDuty, Slack).
* [`docs/timeouts-and-retries.md`](./timeouts-and-retries.md) —
  RetryObserver / retry-metric definitions.
* [`docs/graceful-shutdown.md`](./graceful-shutdown.md) — `shutdown_*`
  metrics.
* [`docs/idempotent-consumer.md`](./idempotent-consumer.md) —
  `idempotency_guard_checks_total` semantics.
* [`docs/audit-log.md`](./audit-log.md) — `audit_chain_*` metrics.
* [`monitoring/README.md`](../monitoring/README.md) — operator's-eye-view of
  the monitoring stack on disk.
* [`monitoring/DASHBOARD_SCREENSHOTS.md`](../monitoring/DASHBOARD_SCREENSHOTS.md)
  — what each panel looks like visually.
* [`docs/api.md`](./api.md) — public API reference and OpenAPI entry point (`docs/openapi.yaml`); links every public endpoint to the metrics it appears in on this dashboard.
* [`docs/error-codes.md`](./error-codes.md) — public API error catalogue.

If you are about to add a new metric: edit the file listed in §3, follow the
cardinality rules in [`docs/sla-metrics.md`](./sla-metrics.md#cardinality-policy),
add a panel to `monitoring/grafana/dashboard.json`, and add an alert
[`monitoring/prometheus/alerts.yml`](../monitoring/prometheus/alerts.yml)
when the failure mode is critical. Then come back and update §3 here.
