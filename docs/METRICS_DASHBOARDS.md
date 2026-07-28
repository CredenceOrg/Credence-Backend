# Grafana Metrics & Dashboards Reference

This document maps the panels of the Credence Backend Grafana dashboard (`monitoring/grafana/dashboard.json`) to their corresponding Service Level Indicators (SLIs) and Service Level Objectives (SLOs).

It is written for **operators and service administrators** who monitor the production environment, triage alerts, and track system compliance.

---

## Dashboard Overview

- **Title**: Credence Backend - API Monitoring
- **UID**: `credence-backend-dashboard`
- **Default Time Range**: Last 1 hour (10s auto-refresh)
- **Primary Metrics Source**: Prometheus (`DS_PROMETHEUS` variable)

---

## SLO & SLI Mapping Matrix

The following table summarizes which dashboard panels visualize which SLIs/SLOs and the PromQL queries backing them:

| Dashboard Panel | Visualized SLI | SLO Target / Alert Threshold | Primary Metric / PromQL Query |
| :--- | :--- | :--- | :--- |
| **HTTP Error Rate (5xx)** | Success Rate SLI | **Target**: 99.9% Success Rate (0.1% Error Budget)<br>**Alert**: Error rate > 0.1% for 2m | `rate(http_requests_total{job="credence-backend", status=~"5.."}[5m]) / rate(http_requests_total{job="credence-backend"}[5m])` |
| **HTTP Request Latency (p50, p95, p99)** | Latency Percentile SLI | **Alert**: High p99 latency > 1s for 5m | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="credence-backend"}[5m]))` |
| **SLA Compliance: % Requests < 250ms** | Request SLA SLI | **Target**: 95% of successful requests complete within 250ms | `sum(rate(http_request_duration_seconds_bucket{le="0.25", status_class="2xx"}[5m])) by (route) / sum(rate(http_request_duration_seconds_count{status_class="2xx"}[5m])) by (route)` |
| **Database Health** | Database Availability SLI | **Alert**: DB health check fails for 1m (Binary 1/0) | `health_check_status{job="credence-backend", dependency="db"}` |
| **Redis Health** | Redis Availability SLI | **Alert**: Redis health check fails for 1m (Binary 1/0) | `health_check_status{job="credence-backend", dependency="redis"}` |
| **Health Check Duration** | Dependency Latency SLI | **Alert**: Health check duration > 3s for 5m | `health_check_duration_seconds{job="credence-backend", dependency="db"}` |
| **Outbox Published/Failed** | Outbox Throughput SLI | Monitor publishing rates and failures | `rate(outbox_published_total[5m])` / `rate(outbox_failed_total[5m])` |
| **Outbox Pending Events** | Outbox Backlog SLI | Monitor queue backlog / lag | `outbox_pending_gauge` |
| **Horizon Listener Lag** | Horizon Sync Lag SLI | Sync lag relative to Stellar network ledger | `max by (stream) (horizon_listener_lag_seconds)` |

---

## Detailed Panel Reference & Troubleshooting

### 1. HTTP Error Rate (5xx)
- **Panel Type**: Gauge
- **Aesthetic Thresholds**: Green (0–0.05% error rate), Red (>0.05% error rate)
- **Concrete Example Output**:
  ```http
  # Metric format exposed at /metrics
  http_requests_total{method="POST", route="/api/bulk/verify", status="500"} 12
  http_requests_total{method="POST", route="/api/bulk/verify", status="200"} 12000
  ```
- **Operator Action**: If the gauge leaves the green zone:
  1. Inspect the central logs using the request context ID: `X-Request-ID`.
  2. Search for logs with `LogEventType.HTTP_ERROR` containing the stack traces.
  3. Verify if database or Redis dependencies are degraded.

### 2. SLA Compliance: % Requests < 250ms (Success Only)
- **Panel Type**: Table/Time Series
- **Aesthetic Thresholds**: Green (>=95% compliance), Red (<95% compliance)
- **Concrete Example Output**:
  ```http
  # Metric format exposed at /metrics
  http_request_duration_seconds_bucket{method="GET", route="/api/trust/:address", status_class="2xx", le="0.25"} 950
  http_request_duration_seconds_count{method="GET", route="/api/trust/:address", status_class="2xx"} 1000
  ```
  *Compliance Calculation*: $950 / 1000 = 95.0\%$ compliance.
- **Operator Action**: If compliance drops below 95%:
  1. Identify the specific slow route(s) in the dashboard table (e.g., `/api/trust/:address`).
  2. Check `docs/sla-metrics.md` for cache vs. database latency target alignments (e.g., cache targets are 200ms, queue operations are 500ms, DB is 1000ms).
  3. Inspect slow database query logs via `LogEventType.DB_SLOW_QUERY`.

### 3. Database & Redis Health Gauges
- **Panel Type**: Gauge (Status)
- **Values**: `1` (Up/Healthy), `0` (Down/Unhealthy)
- **Concrete Example Output**:
  ```http
  health_check_status{dependency="db"} 1
  health_check_status{dependency="redis"} 1
  ```
- **Operator Action**: If either gauge shows `0`:
  1. Check connectivity logs and check if the database/Redis containers are alive: `docker-compose ps`.
  2. For Database, check PostgreSQL pool saturation: `db_prepared_statement_cache_size` or waiting connections.
  3. For Redis, check `ioredis` connection event listeners.
  4. If Redis is unhealthy due to memory pressure (evictions, `OOM command not allowed`), check `redis_key_size_bytes` (bucketed by `namespace`) for a namespace with observations piling up in the top bucket — that's a single endpoint writing an outsized value (e.g. an unpaginated list cached as one key) rather than general growth. See [Redis Cache Key Size](./OBSERVABILITY.md#redis-cache-key-size) in the observability doc.

### 4. Outbox Pending Events
- **Panel Type**: Gauge / Graph
- **Aesthetic Thresholds**: Yellow (>1000 pending events), Red (>5000 pending events)
- **Concrete Example Output**:
  ```http
  outbox_pending_gauge 125
  ```
- **Operator Action**: If backlog spikes:
  1. Check if the outbox publisher is running: `LogEventType.OUTBOX_PUBLISHER_STARTING` or lease heartbeats.
  2. Look for dead-letter counts: `outbox_dead_letter_total{error_code="..."}`.
  3. Check lease renewal rates: `rate(outbox_lease_renew_total[5m])`.

### 5. Horizon Listener Lag (seconds)
- **Panel Type**: Time Series
- **Aesthetic Thresholds**: Yellow (>60s lag), Red (>300s lag)
- **Concrete Example Output**:
  ```http
  horizon_listener_lag_seconds{stream="trustlines"} 4.5
  horizon_listener_lease_ttl_seconds{stream="trustlines"} 25.0
  ```
- **Operator Action**: If sync lag is high:
  1. Inspect who currently holds the lease: `horizon_listener_fencing_token`.
  2. Verify if the listener is failing to fetch events from Stellar network (Horizon RPC error rates).
  3. Check Horizon network connectivity.

---

## References

- **[Service Level Objectives (SLOs)](./SLO.md)** — Detailed math behind success rate, latency objectives, and burn rates.
- **[SLA Metrics & Normalization](./sla-metrics.md)** — Detailed guide on `http_request_duration_seconds` bucket alignments.
- **[Observability Architecture](./OBSERVABILITY.md)** — central logging schemas, PII redaction, and tracing spans.
- **[Production Runbook](./RUNBOOK.md)** — Step-by-step triage guide for critical alerts.
