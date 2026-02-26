# Monitoring Quick Start Guide

Get Credence Backend monitoring up and running in 5 minutes.

## Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ and npm
- Credence Backend running locally

## Step 1: Install Dependencies

```bash
npm install prom-client
```

## Step 2: Add Metrics to Your Application

Copy the example metrics file:

```bash
cp src/middleware/metrics.example.ts src/middleware/metrics.ts
```

Update `src/index.ts` to include metrics:

```typescript
import { metricsMiddleware, register } from './middleware/metrics.js'

// Add metrics middleware
app.use(metricsMiddleware)

// Add metrics endpoint
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})
```

## Step 3: Start the Monitoring Stack

```bash
docker-compose up -d
```

This starts:
- Prometheus (port 9090)
- Grafana (port 3001)
- PostgreSQL (port 5432) - optional
- Redis (port 6379) - optional

## Step 4: Verify Setup

Check that metrics are being collected:

```bash
# Check metrics endpoint
curl http://localhost:3000/metrics

# Should see output like:
# http_requests_total{method="GET",route="/api/health",status="200"} 1
# http_request_duration_seconds_bucket{le="0.005",method="GET",route="/api/health",status="200"} 1
```

Check Prometheus targets:

```bash
open http://localhost:9090/targets
```

Verify `credence-backend` target shows as UP.

## Step 5: Open Grafana Dashboard

1. Open Grafana: http://localhost:3001
2. Login with `admin` / `admin`
3. Navigate to **Dashboards** → **Credence Backend - API Monitoring**

The dashboard is automatically provisioned and ready to use!

## Step 6: Generate Test Data

Generate some traffic to see metrics:

```bash
# Health checks
for i in {1..50}; do
  curl http://localhost:3000/api/health
  sleep 0.1
done

# Trust score queries
for i in {1..20}; do
  curl http://localhost:3000/api/trust/GABC123...
  sleep 0.2
done

# Bulk verification (requires API key)
curl -X POST http://localhost:3000/api/bulk/verify \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-enterprise-key-12345" \
  -d '{"addresses": ["GABC...", "GDEF...", "GHIJ..."]}'
```

## What You'll See

### Prometheus (http://localhost:9090)

- Query metrics directly
- View targets and their health
- Check alert rules

Example queries:
```promql
# Request rate
rate(http_requests_total[5m])

# P95 latency
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Error rate
rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m])
```

### Grafana (http://localhost:3001)

The dashboard shows:

**Top Row:**
- HTTP Error Rate gauge (5xx responses)
- Request Rate time series
- Request Latency (p50, p95)

**Middle Row:**
- Status Code Distribution
- Database Health gauge
- Redis Health gauge

**Bottom Rows:**
- Health Check Duration
- Business Operations Rate
- Operation Duration (p95)
- Bulk Verification Batch Size
- Total Verifications (24h)

## Troubleshooting

### Metrics endpoint returns 404

Make sure you:
1. Installed `prom-client`: `npm install prom-client`
2. Created `src/middleware/metrics.ts`
3. Added metrics middleware and endpoint to `src/index.ts`
4. Restarted the backend

### Prometheus target is DOWN

Check:
1. Backend is running on port 3000
2. Metrics endpoint is accessible: `curl http://localhost:3000/metrics`
3. Docker can reach host: Update `prometheus.yml` target if needed

For Docker Desktop on Mac/Windows, use `host.docker.internal:3000`.
For Linux, use `172.17.0.1:3000` or host IP.

### Dashboard is empty

1. Check time range (top right) - try "Last 5 minutes"
2. Verify Prometheus datasource is configured (Configuration → Data Sources)
3. Generate some traffic to create metrics
4. Check Prometheus has data: http://localhost:9090/graph

### Can't access Grafana

1. Check container is running: `docker-compose ps`
2. Check logs: `docker-compose logs grafana`
3. Verify port 3001 is not in use: `lsof -i :3001`

## Next Steps

1. **Instrument your code**: Add metrics to business operations
   - See `src/middleware/metrics.example.ts` for helper functions
   - Update health checks, reputation calculations, identity sync

2. **Configure alerts**: Set up Alertmanager for notifications
   - See `monitoring/prometheus/alerts.yml`
   - Configure Slack, PagerDuty, or email notifications

3. **Customize dashboard**: Add panels for your specific needs
   - Edit in Grafana UI
   - Export and save to `monitoring/grafana/dashboard.json`

4. **Production deployment**: See [docs/monitoring.md](docs/monitoring.md)
   - Kubernetes ServiceMonitor
   - Remote storage
   - High availability setup

## Stopping the Stack

```bash
# Stop containers
docker-compose down

# Stop and remove volumes (deletes data)
docker-compose down -v
```

## Resources

- Full documentation: [docs/monitoring.md](docs/monitoring.md)
- Monitoring directory: [monitoring/README.md](monitoring/README.md)
- Prometheus docs: https://prometheus.io/docs/
- Grafana docs: https://grafana.com/docs/

## Support

For issues:
1. Check [docs/monitoring.md#troubleshooting](docs/monitoring.md#troubleshooting)
2. Review container logs: `docker-compose logs`
3. Verify network connectivity between services
