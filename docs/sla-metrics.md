# SLA Metrics - Percentile Latency

## Overview

Percentile latency metrics (p50, p95, p99) for HTTP requests with safe route template normalization to prevent cardinality explosion.

## Metrics

### `http_request_duration_seconds`

**Type:** Histogram  
**Labels:** `method`, `route`, `status_class`  
**Buckets:** `0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 2.5, 5, 7.5, 10`  
**Description:** HTTP request latency distribution for SLO tracking

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

**SLA compliance (% of requests under 250ms):**
```promql
sum(rate(http_request_duration_seconds_bucket{le="0.25"}[5m])) 
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

**SLA breach:**
```yaml
- alert: SLABreach
  expr: |
    (
      sum(rate(http_request_duration_percentiles_seconds_bucket{le="0.2"}[5m])) 
      / 
      sum(rate(http_request_duration_percentiles_seconds_count[5m]))
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
