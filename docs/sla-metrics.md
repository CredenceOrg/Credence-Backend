# SLA Metrics - Percentile Latency

## Overview

Percentile latency metrics (p50, p95, p99) for HTTP requests with safe route template normalization to prevent cardinality explosion.

## Metrics

### `http_request_duration_seconds`

**Type:** Histogram  
**Labels:** `method`, `route`, `status_class`  
**Buckets (seconds):** `0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5, 5, 10`  
**Constant:** `HTTP_LATENCY_BUCKETS_S` — exported from `src/observability/latencyMetrics.ts`  
**Description:** HTTP request latency distribution for SLO tracking

The three SLO fence-posts are kept as explicit bucket boundaries so that
`histogram_quantile()` and range queries land on exact edges without interpolation:

| Bucket | Milliseconds | SLO alignment |
|--------|-------------|---------------|
| `0.2`  | 200 ms      | Cache-operation SLO target (`cache.targetMs` in `src/lib/timeouts.ts`) |
| `0.5`  | 500 ms      | Queue-operation SLO target (`queue.targetMs` in `src/lib/timeouts.ts`) |
| `1`    | 1000 ms     | Database SLO target + p99 alert threshold (`HighP99Latency` in `alerts.yml`) |

The bucket array is defined once in
[`src/observability/latencyMetrics.ts`](../src/observability/latencyMetrics.ts)
as `HTTP_LATENCY_BUCKETS_S` and reused by the histogram, tests, and this document.

**Example output:**
```
# HELP http_request_duration_seconds HTTP request latency in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/api/trust/:address",status_class="2xx",le="0.01"} 10
http_request_duration_seconds_bucket{method="GET",route="/api/trust/:address",status_class="2xx",le="0.25"} 950
http_request_duration_seconds_bucket{method="GET",route="/api/trust/:address",status_class="2xx",le="+Inf"} 1000
http_request_duration_seconds_sum{method="GET",route="/api/trust/:address",status_class="2xx"} 12.5
http_request_duration_seconds_count{method="GET",route="/api/trust/:address",status_class="2xx"} 1000
```

### `downstream_rpc_latency_milliseconds`

**Type:** Histogram  
**Labels:** `provider`, `op`  
**Buckets (ms):** `25, 50, 100, 250, 500, 1000`  
**Description:** Wall-clock latency of outbound RPC calls to downstream providers
(e.g. Soroban), including retries and any time spent gated by the circuit
breaker. Recorded for both successful and failed calls.

- **`provider`** — downstream provider, e.g. `soroban`.
- **`op`** — RPC method / operation invoked, e.g. `getContractData`, `getEvents`.

The bucket boundaries are defined once in
[`src/observability/rpcLatencyMetrics.ts`](../src/observability/rpcLatencyMetrics.ts)
as `DOWNSTREAM_RPC_LATENCY_BUCKETS_MS` and reused everywhere.

**Example output:**
```
# HELP downstream_rpc_latency_milliseconds Downstream RPC call latency in milliseconds, labelled by provider and op
# TYPE downstream_rpc_latency_milliseconds histogram
downstream_rpc_latency_milliseconds_bucket{provider="soroban",op="getContractData",le="25"} 4
downstream_rpc_latency_milliseconds_bucket{provider="soroban",op="getContractData",le="100"} 87
downstream_rpc_latency_milliseconds_bucket{provider="soroban",op="getContractData",le="1000"} 100
downstream_rpc_latency_milliseconds_bucket{provider="soroban",op="getContractData",le="+Inf"} 100
downstream_rpc_latency_milliseconds_sum{provider="soroban",op="getContractData"} 6420
downstream_rpc_latency_milliseconds_count{provider="soroban",op="getContractData"} 100
```

**p95 latency by provider/op:**
```promql
histogram_quantile(0.95, sum(rate(downstream_rpc_latency_milliseconds_bucket[5m])) by (le, provider, op))
```

**Cardinality:** bounded by `providers × ops` (a handful of each), well within
Prometheus limits.

## Cardinality Policy

### Route Template Normalization

Dynamic route segments are normalized to prevent cardinality explosion:

| Original Path | Normalized Template |
|--------------|---------------------|
| `/api/trust/0x123abc` | `/api/trust/:address` |
| `/api/bond/GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ` | `/api/bond/:address` |
| `/api/jobs/550e8400-e29b-41d4-a716-446655440000` | `/api/jobs/:id` |
| `/api/users/12345` | `/api/users/:id` |
| `/api/attestations/0xabc/verify/123` | `/api/attestations/:address/verify/:id` |

### Cardinality Bounds

**Formula:** `methods × routes × status_codes`

- **Methods:** ~10 (GET, POST, PUT, DELETE, PATCH, etc.)
- **Routes:** ~50 (bounded by API surface area)
- **Status classes:** 5 (1xx, 2xx, 3xx, 4xx, 5xx)

**Total series:** ~2,500 time series (well within Prometheus limits)

### Implementation

1. **Primary strategy:** Use `req.route.path` from Express (already templated)
2. **Fallback strategy:** Pattern-based normalization for unmatched routes:
   - Hex addresses: `/0x[a-fA-F0-9]+/` → `/:address`
   - UUIDs: `/[uuid-pattern]/` → `/:id`
   - Numeric IDs: `/\d+/` → `/:id`

### Safety Guarantees

- **Bounded cardinality:** Max ~50 unique route templates
- **No user input in labels:** All dynamic segments normalized
- **Automatic cleanup:** Summary metrics expire after 10 minutes (5 age buckets × 2 minutes)

## Usage

### Middleware Integration

```typescript
import { latencyMetricsMiddleware } from './middleware/latencyMetrics.js'

app.use(latencyMetricsMiddleware)
```

### Querying Metrics

**p95 latency by route:**
```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
```

**p99 latency for specific endpoint:**
```promql
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{route="/api/trust/:address"}[5m])) by (le))
```

**Average latency (from sum/count):**
```promql
rate(http_request_duration_seconds_sum[5m]) 
/ 
rate(http_request_duration_seconds_count[5m])
```

**SLA compliance (% of requests under 200ms — cache SLO target):**
```promql
sum(rate(http_request_duration_seconds_bucket{le="0.2"}[5m])) 
/ 
sum(rate(http_request_duration_seconds_count[5m]))
```

**SLA compliance (% of requests under 500ms — queue SLO target):**
```promql
sum(rate(http_request_duration_seconds_bucket{le="0.5"}[5m])) 
/ 
sum(rate(http_request_duration_seconds_count[5m]))
```

**SLA compliance (% of requests under 1000ms — database SLO / p99 threshold):**
```promql
sum(rate(http_request_duration_seconds_bucket{le="1"}[5m])) 
/ 
sum(rate(http_request_duration_seconds_count[5m]))
```

## Grafana Dashboard

Add panels for:

1. **p50/p95/p99 latency by route** (line graph)
2. **SLA compliance table** (% of successful requests < 250ms)
3. **HTTP Error Rate (5xx)** (gauge)
4. **Latency heatmap** (heatmap visualization)

Example query for panel 1 (p99):
```promql
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{job="credence-backend"}[5m]))
```

## Testing

Run tests:
```bash
npm test src/__tests__/latencyMetrics.test.ts
npm test src/__tests__/latencyMetricsMiddleware.test.ts
```

Coverage includes:
- Route normalization correctness
- Cardinality bounds verification
- Middleware integration with Express
- Multiple HTTP methods and status codes
- Percentile calculation accuracy

## Monitoring

### Alerts

**High p99 latency:**
```yaml
- alert: HighP99Latency
  expr: |
    histogram_quantile(0.99, 
      sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route)
    ) > 1
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High p99 latency on {{ $labels.route }}"
    description: "P99 latency is {{ $value }}s (Threshold: 1s)"
```

**SLA breach (< 95% of requests under 200 ms cache SLO target):**
```yaml
- alert: SLABreach
  expr: |
    (
      sum(rate(http_request_duration_seconds_bucket{le="0.2"}[5m])) 
      / 
      sum(rate(http_request_duration_seconds_count[5m]))
    ) < 0.95
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "SLA breach: <95% of requests under 200ms"
```

## Performance Impact

- **CPU overhead:** <1% (high-resolution timer + label lookup)
- **Memory overhead:** ~100KB per 1000 unique label combinations
- **Prometheus scrape size:** ~5KB per scrape (5000 series × 1 byte avg)

## References

- [Prometheus Summary Metric](https://prometheus.io/docs/practices/histograms/)
- [Cardinality Best Practices](https://prometheus.io/docs/practices/naming/#labels)
- [Express Route Matching](https://expressjs.com/en/guide/routing.html)
- [Performance Baselines Documentation](./PERF_BASELINE.md)

