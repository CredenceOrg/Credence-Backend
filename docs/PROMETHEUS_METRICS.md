# Prometheus Metrics Export

Complete guide to Prometheus metrics integration in Credence Backend.

## Overview

The Credence Backend exposes Prometheus-compatible metrics at the `/metrics` endpoint for monitoring and observability. Metrics include HTTP request tracking, business events, and Node.js runtime metrics.

## Metrics Endpoint

### GET /metrics

Returns metrics in Prometheus text format for scraping.

**URL:** `http://localhost:3000/metrics`

**Response Format:** `text/plain; version=0.0.4; charset=utf-8`

**Example Request:**

```bash
curl http://localhost:3000/metrics
```

**Example Response:**

```
# HELP http_request_duration_seconds Duration of HTTP requests in seconds
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.01",method="GET",route="/api/trust/:address",status_code="200"} 45
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/api/trust/:address",status_code="200"} 98
http_request_duration_seconds_bucket{le="0.1",method="GET",route="/api/trust/:address",status_code="200"} 150
...

# HELP http_requests_total Total number of HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/trust/:address",status_code="200"} 150
http_requests_total{method="POST",route="/api/bulk/verify",status_code="200"} 25
...

# HELP bond_events_total Total number of bond creation events
# TYPE bond_events_total counter
bond_events_total{address="GABC..."} 5
...

# HELP active_bonds_count Current number of active bonds
# TYPE active_bonds_count gauge
active_bonds_count 150
```

## Available Metrics

### HTTP Metrics

#### http_request_duration_seconds (Histogram)

Duration of HTTP requests in seconds.

**Labels:**
- `method`: HTTP method (GET, POST, etc.)
- `route`: Normalized route path (e.g., `/api/trust/:address`)
- `status_code`: HTTP status code (200, 404, 500, etc.)

**Buckets:** 10ms, 50ms, 100ms, 500ms, 1s, 5s, 10s

**Use Cases:**
- Monitor API response times
- Identify slow endpoints
- Set up latency alerts

#### http_requests_total (Counter)

Total number of HTTP requests.

**Labels:**
- `method`: HTTP method
- `route`: Normalized route path
- `status_code`: HTTP status code

**Use Cases:**
- Track request volume
- Monitor error rates
- Analyze traffic patterns

### Business Metrics

#### bond_events_total (Counter)

Total number of bond creation events.

**Labels:**
- `address`: Stellar address that created the bond

**Use Cases:**
- Track bond creation activity
- Monitor user engagement
- Analyze growth trends

#### slash_events_total (Counter)

Total number of slash events.

**Labels:**
- `reason`: Reason for slashing (fraud, misconduct, etc.)

**Use Cases:**
- Monitor governance actions
- Track slash reasons
- Identify patterns in violations

#### score_calculations_total (Counter)

Total number of trust score calculations.

**Labels:**
- `address`: Stellar address for which score was calculated

**Use Cases:**
- Track score calculation frequency
- Monitor system usage
- Analyze performance

#### identity_verifications_total (Counter)

Total number of identity verifications.

**Labels:**
- `status`: Verification status (success, failed)

**Use Cases:**
- Track verification success rate
- Monitor verification volume
- Identify verification issues

#### bulk_verifications_total (Counter)

Total number of bulk verification requests.

**Labels:**
- `batch_size_range`: Size range of the batch (1-10, 11-50, 51-100)

**Use Cases:**
- Track bulk API usage
- Monitor batch sizes
- Optimize batch processing

#### active_bonds_count (Gauge)

Current number of active bonds.

**Use Cases:**
- Monitor active bond count in real-time
- Track bond lifecycle
- Set up capacity alerts

#### total_bonded_amount (Gauge)

Total amount of XLM currently bonded.

**Use Cases:**
- Monitor total value locked
- Track economic activity
- Analyze liquidity

### Node.js Runtime Metrics

Default Node.js metrics are automatically collected:

- `process_cpu_user_seconds_total`: User CPU time
- `process_cpu_system_seconds_total`: System CPU time
- `process_resident_memory_bytes`: Memory usage
- `nodejs_heap_size_total_bytes`: Heap size
- `nodejs_heap_size_used_bytes`: Used heap
- `nodejs_eventloop_lag_seconds`: Event loop lag
- `nodejs_gc_duration_seconds`: Garbage collection duration
- And more...

## Integration

### Automatic HTTP Tracking

All HTTP requests are automatically tracked via middleware. No manual instrumentation required.

```typescript
// Middleware is applied globally in src/index.ts
app.use(metricsMiddleware)
```

### Manual Business Event Tracking

Track business events in your code:

```typescript
import { getMetricsService, MetricEvent } from './services/metrics/index.js'

const metricsService = getMetricsService()

// Track bond creation
metricsService.recordBusinessEvent(MetricEvent.BOND_CREATED, {
  address: 'GABC123...'
})

// Track slash event
metricsService.recordBusinessEvent(MetricEvent.BOND_SLASHED, {
  reason: 'fraud'
})

// Track score calculation
metricsService.recordBusinessEvent(MetricEvent.SCORE_CALCULATED, {
  address: 'GABC123...'
})

// Track identity verification
metricsService.recordBusinessEvent(MetricEvent.IDENTITY_VERIFIED, {
  status: 'success'
})

// Track bulk verification
metricsService.recordBusinessEvent(MetricEvent.BULK_VERIFICATION, {
  batch_size_range: '11-50'
})
```

### Update Gauges

Update gauge values for real-time metrics:

```typescript
import { getMetricsService } from './services/metrics/index.js'

const metricsService = getMetricsService()

// Update active bonds count
metricsService.setActiveBonds(150)

// Update total bonded amount
metricsService.setTotalBondedAmount(1000000.50)
```

## Prometheus Configuration

### Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'credence-backend'
    scrape_interval: 15s
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
```

### Example Queries

**Request rate by endpoint:**
```promql
rate(http_requests_total[5m])
```

**95th percentile latency:**
```promql
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
```

**Error rate:**
```promql
rate(http_requests_total{status_code=~"5.."}[5m])
```

**Active bonds:**
```promql
active_bonds_count
```

**Total bonded amount:**
```promql
total_bonded_amount
```

**Bond creation rate:**
```promql
rate(bond_events_total[1h])
```

**Slash events by reason:**
```promql
sum by (reason) (slash_events_total)
```

## Grafana Dashboards

### Recommended Panels

1. **Request Rate** - Line graph of `rate(http_requests_total[5m])`
2. **Latency** - Heatmap of `http_request_duration_seconds`
3. **Error Rate** - Line graph of error status codes
4. **Active Bonds** - Gauge of `active_bonds_count`
5. **Total Bonded** - Gauge of `total_bonded_amount`
6. **Bond Events** - Counter of `bond_events_total`
7. **Slash Events** - Bar chart by reason
8. **Memory Usage** - Line graph of `process_resident_memory_bytes`
9. **CPU Usage** - Line graph of `process_cpu_seconds_total`

### Example Dashboard JSON

```json
{
  "dashboard": {
    "title": "Credence Backend Metrics",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Active Bonds",
        "targets": [
          {
            "expr": "active_bonds_count"
          }
        ]
      }
    ]
  }
}
```

## Alerting

### Example Alert Rules

```yaml
groups:
  - name: credence_alerts
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status_code=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value }} requests/sec"

      - alert: HighLatency
        expr: histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m])) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High latency detected"
          description: "95th percentile latency is {{ $value }}s"

      - alert: HighSlashRate
        expr: rate(slash_events_total[1h]) > 10
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Unusual slash activity"
          description: "Slash rate is {{ $value }} events/hour"
```

## Testing

Comprehensive test coverage (66 tests) ensures metrics reliability:

- Unit tests for MetricsService
- Middleware integration tests
- Route endpoint tests
- Full integration tests

Run tests:

```bash
npm test -- src/services/metrics/
npm test -- src/middleware/metrics.test.ts
npm test -- src/routes/metrics.test.ts
npm test -- src/__tests__/metrics.integration.test.ts
```

## Performance Considerations

- Metrics collection has minimal overhead (<1ms per request)
- Default metrics are collected asynchronously
- Histogram buckets are optimized for typical API latencies
- Counters and gauges are thread-safe

## Security

- The `/metrics` endpoint is publicly accessible (standard for Prometheus)
- Consider adding authentication in production environments
- Metrics do not expose sensitive data (addresses are hashed/truncated in production)
- No PII is included in metric labels

## Troubleshooting

### Metrics not appearing

1. Check that the server is running: `curl http://localhost:3000/metrics`
2. Verify middleware is applied before routes
3. Check Prometheus scrape configuration

### High memory usage

1. Review metric cardinality (number of unique label combinations)
2. Consider aggregating high-cardinality labels
3. Adjust scrape interval in Prometheus

### Missing business metrics

1. Ensure events are being recorded in application code
2. Check that `getMetricsService()` is called correctly
3. Verify event types match `MetricEvent` enum

## Architecture

```
src/services/metrics/
├── types.ts              # TypeScript types and enums
├── metricsService.ts     # Core metrics service
├── index.ts              # Public exports
└── metricsService.test.ts # Unit tests

src/middleware/
├── metrics.ts            # HTTP tracking middleware
└── metrics.test.ts       # Middleware tests

src/routes/
├── metrics.ts            # /metrics endpoint
└── metrics.test.ts       # Route tests
```

## Dependencies

- `prom-client`: Official Prometheus client for Node.js
- Automatically collects default Node.js metrics
- Zero configuration required for basic usage

## Further Reading

- [Prometheus Documentation](https://prometheus.io/docs/)
- [prom-client GitHub](https://github.com/siimon/prom-client)
- [Grafana Dashboards](https://grafana.com/docs/grafana/latest/dashboards/)
- [PromQL Guide](https://prometheus.io/docs/prometheus/latest/querying/basics/)
