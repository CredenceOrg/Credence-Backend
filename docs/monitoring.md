# Monitoring and Observability

This document describes the monitoring setup for Credence Backend, including Prometheus metrics instrumentation and Grafana dashboard configuration.

## Overview

The monitoring stack consists of:
- **Prometheus** - Metrics collection and storage
- **Grafana** - Visualization and dashboards
- **Application metrics** - Custom business and infrastructure metrics

## Architecture

```
┌─────────────────┐
│ Credence Backend│
│   (Express)     │──── Exposes /metrics endpoint
└────────┬────────┘
         │
         │ scrapes
         ▼
┌─────────────────┐
│   Prometheus    │──── Stores time-series data
└────────┬────────┘
         │
         │ queries
         ▼
┌─────────────────┐
│    Grafana      │──── Visualizes metrics
└─────────────────┘
```

## Metrics Instrumentation

### Required Dependencies

Add Prometheus client library to your project:

```bash
npm install prom-client
```

### Metrics Implementation

Create `src/middleware/metrics.ts`:


```typescript
import { Request, Response, NextFunction } from 'express'
import client from 'prom-client'

// Create a Registry
export const register = new client.Registry()

// Add default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register })

// HTTP Metrics
export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
})

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
})

// Health Check Metrics
export const healthCheckStatus = new client.Gauge({
  name: 'health_check_status',
  help: 'Health check status (1 = up, 0 = down)',
  labelNames: ['dependency'],
  registers: [register]
})

export const healthCheckDuration = new client.Gauge({
  name: 'health_check_duration_seconds',
  help: 'Duration of health checks in seconds',
  labelNames: ['dependency'],
  registers: [register]
})

// Business Metrics
export const reputationScoreCalculations = new client.Counter({
  name: 'reputation_score_calculations_total',
  help: 'Total number of reputation score calculations',
  registers: [register]
})

export const reputationCalculationDuration = new client.Histogram({
  name: 'reputation_calculation_duration_seconds',
  help: 'Duration of reputation calculations in seconds',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register]
})

export const identityVerifications = new client.Counter({
  name: 'identity_verifications_total',
  help: 'Total number of identity verifications',
  labelNames: ['status'],
  registers: [register]
})

export const bulkVerifications = new client.Counter({
  name: 'bulk_verifications_total',
  help: 'Total number of bulk verification requests',
  labelNames: ['status'],
  registers: [register]
})

export const bulkVerificationBatchSize = new client.Histogram({
  name: 'bulk_verification_batch_size',
  help: 'Size of bulk verification batches',
  buckets: [1, 5, 10, 25, 50, 75, 100],
  registers: [register]
})

export const identitySyncDuration = new client.Histogram({
  name: 'identity_sync_duration_seconds',
  help: 'Duration of identity state sync operations',
  labelNames: ['operation'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register]
})

// Middleware to track HTTP metrics
export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000
    const route = req.route?.path || req.path
    
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status: res.statusCode
    })
    
    httpRequestDuration.observe({
      method: req.method,
      route,
      status: res.statusCode
    }, duration)
  })
  
  next()
}
```


### Integrate Metrics into Application

Update `src/index.ts`:

```typescript
import express from 'express'
import { metricsMiddleware, register } from './middleware/metrics.js'
import { createHealthRouter } from './routes/health.js'
import { createDefaultProbes } from './services/health/probes.js'

const app = express()
const PORT = process.env.PORT ?? 3000

app.use(express.json())

// Add metrics middleware
app.use(metricsMiddleware)

// Metrics endpoint for Prometheus
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

const healthProbes = createDefaultProbes()
app.use('/api/health', createHealthRouter(healthProbes))

// ... rest of your routes

app.listen(PORT, () => {
  console.log(`Credence API listening on http://localhost:${PORT}`)
})

export default app
```

### Instrument Health Checks

Update `src/services/health/checks.ts` to emit metrics:

```typescript
import { healthCheckStatus, healthCheckDuration } from '../../middleware/metrics.js'

export async function runHealthChecks(probes: {
  db?: HealthProbe
  redis?: HealthProbe
  external?: HealthProbe
}): Promise<HealthResult> {
  // Run checks and measure duration
  const dbStart = Date.now()
  const db = probes.db ? await probes.db() : { status: 'not_configured' as const }
  healthCheckDuration.set({ dependency: 'db' }, (Date.now() - dbStart) / 1000)
  healthCheckStatus.set({ dependency: 'db' }, db.status === 'up' ? 1 : 0)

  const redisStart = Date.now()
  const redis = probes.redis ? await probes.redis() : { status: 'not_configured' as const }
  healthCheckDuration.set({ dependency: 'redis' }, (Date.now() - redisStart) / 1000)
  healthCheckStatus.set({ dependency: 'redis' }, redis.status === 'up' ? 1 : 0)

  // ... rest of health check logic
}
```

### Instrument Business Operations

Update `src/services/identityService.ts`:

```typescript
import { identityVerifications, bulkVerifications, bulkVerificationBatchSize } from '../middleware/metrics.js'

export class IdentityService {
  async verifyIdentity(address: string): Promise<IdentityVerification> {
    try {
      // ... verification logic
      identityVerifications.inc({ status: 'success' })
      return result
    } catch (error) {
      identityVerifications.inc({ status: 'error' })
      throw error
    }
  }

  async verifyBulk(addresses: string[]): Promise<{
    results: IdentityVerification[]
    errors: VerificationError[]
  }> {
    bulkVerificationBatchSize.observe(addresses.length)
    
    try {
      // ... bulk verification logic
      bulkVerifications.inc({ status: 'success' })
      return { results, errors }
    } catch (error) {
      bulkVerifications.inc({ status: 'error' })
      throw error
    }
  }
}
```

Update `src/services/reputation/score.ts`:

```typescript
import { reputationScoreCalculations, reputationCalculationDuration } from '../../middleware/metrics.js'

export function calculateReputationScore(input: ReputationInput): ReputationScore {
  const start = Date.now()
  
  // ... calculation logic
  
  reputationScoreCalculations.inc()
  reputationCalculationDuration.observe((Date.now() - start) / 1000)
  
  return result
}
```

Update `src/listeners/identityStateSync.ts`:

```typescript
import { identitySyncDuration } from '../middleware/metrics.js'

export class IdentityStateSync {
  async reconcileByAddress(address: string): Promise<ReconcileResult> {
    const start = Date.now()
    
    try {
      // ... reconciliation logic
      return result
    } finally {
      identitySyncDuration.observe({ operation: 'reconcile' }, (Date.now() - start) / 1000)
    }
  }

  async fullResync(): Promise<FullResyncResult> {
    const start = Date.now()
    
    try {
      // ... full resync logic
      return result
    } finally {
      identitySyncDuration.observe({ operation: 'full_resync' }, (Date.now() - start) / 1000)
    }
  }
}
```


## Prometheus Configuration

### Prometheus Setup

Create `monitoring/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'credence-production'
    environment: 'production'

scrape_configs:
  - job_name: 'credence-backend'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
    scrape_interval: 10s
    scrape_timeout: 5s
```

### Running Prometheus

Using Docker:

```bash
docker run -d \
  --name prometheus \
  -p 9090:9090 \
  -v $(pwd)/monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml \
  prom/prometheus
```

Using Docker Compose (create `docker-compose.yml`):

```yaml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    container_name: prometheus
    ports:
      - "9090:9090"
    volumes:
      - ./monitoring/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    command:
      - '--config.file=/etc/prometheus/prometheus.yml'
      - '--storage.tsdb.path=/prometheus'
      - '--web.console.libraries=/usr/share/prometheus/console_libraries'
      - '--web.console.templates=/usr/share/prometheus/consoles'
    restart: unless-stopped

  grafana:
    image: grafana/grafana:latest
    container_name: grafana
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
      - GF_USERS_ALLOW_SIGN_UP=false
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana:/etc/grafana/provisioning/dashboards
    depends_on:
      - prometheus
    restart: unless-stopped

volumes:
  prometheus-data:
  grafana-data:
```

Start the stack:

```bash
docker-compose up -d
```


## Grafana Dashboard

### Dashboard Overview

The Credence Backend dashboard (`monitoring/grafana/dashboard.json`) provides comprehensive monitoring across:

1. **HTTP Metrics**
   - Error rate (5xx responses)
   - Request rate by endpoint
   - Request latency (p50, p95)
   - Status code distribution

2. **Infrastructure Health**
   - Database health status
   - Redis health status
   - Health check duration

3. **Business Metrics**
   - Reputation score calculations
   - Identity verifications
   - Bulk verification operations
   - Batch size distribution
   - Operation duration (p95)

### Importing the Dashboard

#### Method 1: Grafana UI

1. Open Grafana at `http://localhost:3001` (default credentials: admin/admin)
2. Navigate to **Dashboards** → **Import**
3. Click **Upload JSON file**
4. Select `monitoring/grafana/dashboard.json`
5. Select your Prometheus data source
6. Click **Import**

#### Method 2: Provisioning (Automated)

Create `monitoring/grafana/provisioning/dashboards/dashboard.yml`:

```yaml
apiVersion: 1

providers:
  - name: 'Credence Dashboards'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: false
    updateIntervalSeconds: 10
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards
```

Create `monitoring/grafana/provisioning/datasources/prometheus.yml`:

```yaml
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: true
```

Update `docker-compose.yml` to mount provisioning configs:

```yaml
  grafana:
    image: grafana/grafana:latest
    volumes:
      - grafana-data:/var/lib/grafana
      - ./monitoring/grafana/provisioning:/etc/grafana/provisioning
      - ./monitoring/grafana/dashboard.json:/etc/grafana/provisioning/dashboards/credence-backend.json
```

Restart Grafana:

```bash
docker-compose restart grafana
```

The dashboard will be automatically imported and available.


### Dashboard Panels

#### Panel 1: HTTP Error Rate (5xx)
- **Type**: Gauge
- **Query**: `rate(http_requests_total{job="credence-backend", status=~"5.."}[5m]) / rate(http_requests_total{job="credence-backend"}[5m])`
- **Purpose**: Monitor server error rate; alerts when > 5%

#### Panel 2: HTTP Request Rate
- **Type**: Time series
- **Query**: `rate(http_requests_total{job="credence-backend"}[5m])`
- **Purpose**: Track request volume by endpoint and status

#### Panel 3: HTTP Request Latency
- **Type**: Time series
- **Queries**: 
  - p95: `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))`
  - p50: `histogram_quantile(0.50, rate(http_request_duration_seconds_bucket[5m]))`
- **Purpose**: Monitor response times; identify slow endpoints

#### Panel 4: HTTP Status Codes Distribution
- **Type**: Time series (stacked)
- **Query**: `rate(http_requests_total{job="credence-backend"}[5m])`
- **Purpose**: Visualize 2xx, 4xx, 5xx distribution

#### Panel 5: Database Health
- **Type**: Gauge
- **Query**: `health_check_status{job="credence-backend", dependency="db"}`
- **Purpose**: Real-time DB connectivity status

#### Panel 6: Redis Health
- **Type**: Gauge
- **Query**: `health_check_status{job="credence-backend", dependency="redis"}`
- **Purpose**: Real-time Redis connectivity status

#### Panel 7: Health Check Duration
- **Type**: Time series
- **Queries**:
  - DB: `health_check_duration_seconds{dependency="db"}`
  - Redis: `health_check_duration_seconds{dependency="redis"}`
- **Purpose**: Monitor health check performance

#### Panel 8: Business Metrics - Operations Rate
- **Type**: Time series
- **Queries**:
  - `rate(reputation_score_calculations_total[5m])`
  - `rate(identity_verifications_total[5m])`
  - `rate(bulk_verifications_total[5m])`
- **Purpose**: Track business operation volume

#### Panel 9: Business Operations Duration (p95)
- **Type**: Time series
- **Queries**:
  - `histogram_quantile(0.95, rate(reputation_calculation_duration_seconds_bucket[5m]))`
  - `histogram_quantile(0.95, rate(identity_sync_duration_seconds_bucket[5m]))`
- **Purpose**: Monitor performance of critical business operations

#### Panel 10: Avg Bulk Verification Batch Size
- **Type**: Gauge
- **Query**: `avg(bulk_verification_batch_size)`
- **Purpose**: Track average batch size for capacity planning

#### Panel 11: Total Verifications (24h)
- **Type**: Stat
- **Query**: `sum(increase(identity_verifications_total[24h]))`
- **Purpose**: Daily verification volume


## Alerting

### Recommended Alerts

Create `monitoring/prometheus/alerts.yml`:

```yaml
groups:
  - name: credence_backend_alerts
    interval: 30s
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{job="credence-backend", status=~"5.."}[5m]) 
          / rate(http_requests_total{job="credence-backend"}[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High HTTP error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} (threshold: 5%)"

      # High latency
      - alert: HighLatency
        expr: |
          histogram_quantile(0.95, 
            rate(http_request_duration_seconds_bucket{job="credence-backend"}[5m])
          ) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High request latency detected"
          description: "P95 latency is {{ $value }}s (threshold: 2s)"

      # Database down
      - alert: DatabaseDown
        expr: health_check_status{job="credence-backend", dependency="db"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Database is down"
          description: "PostgreSQL health check failing"

      # Redis down
      - alert: RedisDown
        expr: health_check_status{job="credence-backend", dependency="redis"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Redis is down"
          description: "Redis health check failing"

      # Slow health checks
      - alert: SlowHealthCheck
        expr: health_check_duration_seconds{job="credence-backend"} > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Health check is slow"
          description: "{{ $labels.dependency }} health check taking {{ $value }}s"

      # Low verification rate (business metric)
      - alert: LowVerificationRate
        expr: rate(identity_verifications_total{job="credence-backend"}[10m]) < 0.1
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "Low identity verification rate"
          description: "Verification rate dropped to {{ $value }} req/s"
```

Update `prometheus.yml` to include alerts:

```yaml
rule_files:
  - 'alerts.yml'

alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - 'alertmanager:9093'
```


## Deployment

### Kubernetes Deployment

#### ServiceMonitor for Prometheus Operator

Create `k8s/servicemonitor.yaml`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: credence-backend
  namespace: default
  labels:
    app: credence-backend
spec:
  selector:
    matchLabels:
      app: credence-backend
  endpoints:
    - port: http
      path: /metrics
      interval: 15s
```

#### ConfigMap for Grafana Dashboard

Create `k8s/grafana-dashboard-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: credence-backend-dashboard
  namespace: monitoring
  labels:
    grafana_dashboard: "1"
data:
  credence-backend.json: |
    # Paste contents of monitoring/grafana/dashboard.json here
```

Apply:

```bash
kubectl apply -f k8s/servicemonitor.yaml
kubectl apply -f k8s/grafana-dashboard-configmap.yaml
```

### Production Considerations

1. **Metrics Retention**: Configure Prometheus retention based on storage capacity
   ```yaml
   command:
     - '--storage.tsdb.retention.time=30d'
     - '--storage.tsdb.retention.size=50GB'
   ```

2. **High Availability**: Deploy Prometheus with replication
   ```yaml
   replicas: 2
   ```

3. **Remote Storage**: Use long-term storage (Thanos, Cortex, or cloud providers)

4. **Security**: 
   - Enable authentication on Grafana
   - Restrict Prometheus access
   - Use TLS for metrics endpoints in production

5. **Resource Limits**: Set appropriate limits
   ```yaml
   resources:
     requests:
       memory: "512Mi"
       cpu: "250m"
     limits:
       memory: "1Gi"
       cpu: "500m"
   ```


## Testing

### Verify Metrics Endpoint

```bash
# Check metrics are exposed
curl http://localhost:3000/metrics

# Expected output includes:
# - http_requests_total
# - http_request_duration_seconds
# - health_check_status
# - reputation_score_calculations_total
# - identity_verifications_total
```

### Generate Test Traffic

```bash
# Generate some requests
for i in {1..100}; do
  curl http://localhost:3000/api/health
  curl http://localhost:3000/api/trust/GABC123...
done

# Bulk verification test
curl -X POST http://localhost:3000/api/bulk/verify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-enterprise-key-12345" \
  -d '{"addresses": ["GABC...", "GDEF..."]}'
```

### Query Prometheus

```bash
# Open Prometheus UI
open http://localhost:9090

# Example queries:
# - rate(http_requests_total[5m])
# - histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))
# - health_check_status
```

### View Dashboard

```bash
# Open Grafana
open http://localhost:3001

# Login: admin/admin
# Navigate to: Dashboards → Credence Backend - API Monitoring
```


## Metrics Reference

### HTTP Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_requests_total` | Counter | method, route, status | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | method, route, status | Request duration |

### Health Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `health_check_status` | Gauge | dependency | Health status (1=up, 0=down) |
| `health_check_duration_seconds` | Gauge | dependency | Health check duration |

### Business Metrics

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `reputation_score_calculations_total` | Counter | - | Total reputation calculations |
| `reputation_calculation_duration_seconds` | Histogram | - | Calculation duration |
| `identity_verifications_total` | Counter | status | Total identity verifications |
| `bulk_verifications_total` | Counter | status | Total bulk verification requests |
| `bulk_verification_batch_size` | Histogram | - | Batch size distribution |
| `identity_sync_duration_seconds` | Histogram | operation | Identity sync duration |

### Default Metrics (from prom-client)

- `process_cpu_user_seconds_total` - User CPU time
- `process_cpu_system_seconds_total` - System CPU time
- `process_resident_memory_bytes` - Resident memory
- `nodejs_heap_size_total_bytes` - Heap size
- `nodejs_heap_size_used_bytes` - Used heap
- `nodejs_eventloop_lag_seconds` - Event loop lag


## Troubleshooting

### Metrics Not Appearing

1. **Check metrics endpoint**:
   ```bash
   curl http://localhost:3000/metrics
   ```
   If empty or error, verify prom-client is installed and middleware is registered.

2. **Check Prometheus targets**:
   - Open `http://localhost:9090/targets`
   - Verify `credence-backend` target is UP
   - If DOWN, check network connectivity and firewall rules

3. **Check Prometheus logs**:
   ```bash
   docker logs prometheus
   ```

### Dashboard Not Loading

1. **Verify data source**:
   - Grafana → Configuration → Data Sources
   - Test Prometheus connection
   - Ensure URL is correct (e.g., `http://prometheus:9090`)

2. **Check dashboard queries**:
   - Edit panel → Query inspector
   - Verify metrics exist in Prometheus
   - Check label selectors match your job name

3. **Verify time range**:
   - Ensure dashboard time range has data
   - Try "Last 5 minutes" for recent data

### High Cardinality Issues

If metrics storage grows too large:

1. **Limit label values**:
   - Avoid user IDs or addresses as labels
   - Use fixed label sets (e.g., status: success/error)

2. **Adjust retention**:
   ```yaml
   --storage.tsdb.retention.time=15d
   ```

3. **Use recording rules** for expensive queries:
   ```yaml
   groups:
     - name: credence_recordings
       interval: 30s
       rules:
         - record: job:http_requests:rate5m
           expr: rate(http_requests_total{job="credence-backend"}[5m])
   ```

### Performance Impact

Monitor metrics collection overhead:

```bash
# Check /metrics response time
time curl http://localhost:3000/metrics

# Should be < 100ms
```

If slow:
- Reduce histogram buckets
- Disable default metrics if not needed
- Use summary instead of histogram for high-cardinality data


## Screenshots

### Dashboard Overview
The dashboard provides a comprehensive view of:
- Real-time error rates and request volumes
- Latency percentiles (p50, p95) across all endpoints
- Infrastructure health (DB, Redis) with status indicators
- Business metrics showing verification rates and batch sizes

### Key Visualizations
1. **Top Row**: Error rate gauge, request rate time series, latency percentiles
2. **Middle Row**: Status code distribution, DB health, Redis health
3. **Bottom Rows**: Health check durations, business operation rates, and daily totals

## Next Steps

1. **Install dependencies**:
   ```bash
   npm install prom-client
   ```

2. **Implement metrics middleware** (see code examples above)

3. **Deploy monitoring stack**:
   ```bash
   docker-compose up -d
   ```

4. **Import dashboard** into Grafana

5. **Configure alerts** based on your SLOs

6. **Set up notification channels** (Slack, PagerDuty, email)

## Resources

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [prom-client GitHub](https://github.com/siimon/prom-client)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/best-practices/best-practices-for-creating-dashboards/)

## Support

For issues or questions:
- Check the [troubleshooting section](#troubleshooting)
- Review Prometheus and Grafana logs
- Consult the metrics reference for available metrics
- Verify network connectivity between services
