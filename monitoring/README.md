# Credence Backend Monitoring

This directory contains monitoring configuration for the Credence Backend API.

## Contents

```
monitoring/
├── grafana/
│   ├── dashboard.json              # Main Grafana dashboard
│   └── provisioning/
│       ├── dashboards/
│       │   └── dashboard.yml       # Dashboard provisioning config
│       └── datasources/
│           └── prometheus.yml      # Prometheus datasource config
└── prometheus/
    ├── prometheus.yml              # Prometheus scrape configuration
    └── alerts.yml                  # Alert rules
```

## Quick Start

1. **Start the monitoring stack**:
   ```bash
   docker-compose up -d
   ```

2. **Access services**:
   - Prometheus: http://localhost:9090
   - Grafana: http://localhost:3001 (admin/admin)
   - API metrics: http://localhost:3000/metrics

3. **View dashboard**:
   - Open Grafana at http://localhost:3001
   - Navigate to Dashboards → Credence Backend - API Monitoring

## Dashboard Features

The Grafana dashboard includes:

- **HTTP Metrics**: Request rate, latency (p50, p95), error rate, status codes
- **Health Monitoring**: Database and Redis health status and check duration
- **Business Metrics**: Reputation calculations, identity verifications, bulk operations
- **System Metrics**: CPU, memory, event loop lag (Node.js default metrics)

## Configuration

### Prometheus

- **Scrape interval**: 10s for credence-backend, 15s default
- **Retention**: 30 days or 10GB
- **Target**: `host.docker.internal:3000/metrics`

### Grafana

- **Auto-provisioned**: Dashboard and datasource configured automatically
- **Refresh**: 10s auto-refresh
- **Time range**: Last 1 hour (configurable)

## Alerts

Configured alerts (see `prometheus/alerts.yml`):

- High error rate (>5% for 5m)
- High latency (p95 >2s for 5m)
- Database down (1m)
- Redis down (1m)
- Slow health checks (>3s for 5m)
- Low verification rate (<0.1 req/s for 30m)

## Documentation

See [docs/monitoring.md](../docs/monitoring.md) for:
- Complete setup instructions
- Metrics instrumentation guide
- Deployment configurations
- Troubleshooting guide
- Kubernetes manifests

## Development

### Testing Locally

1. Start the backend with metrics enabled
2. Generate test traffic:
   ```bash
   for i in {1..100}; do curl http://localhost:3000/api/health; done
   ```
3. View metrics in Prometheus or Grafana

### Modifying the Dashboard

1. Edit dashboard in Grafana UI
2. Export JSON: Dashboard settings → JSON Model
3. Save to `grafana/dashboard.json`
4. Commit changes

### Adding New Metrics

1. Define metric in `src/middleware/metrics.ts`
2. Instrument code to collect metric
3. Add panel to Grafana dashboard
4. Update documentation

## Production Deployment

For production:

1. Use Kubernetes ServiceMonitor (see docs/monitoring.md)
2. Configure remote storage for Prometheus
3. Set up alerting (Alertmanager, PagerDuty, Slack)
4. Enable authentication and TLS
5. Configure backup for Grafana dashboards

## Troubleshooting

**Metrics not appearing?**
- Check `/metrics` endpoint is accessible
- Verify Prometheus targets are UP at http://localhost:9090/targets
- Check Docker network connectivity

**Dashboard empty?**
- Verify Prometheus datasource is configured
- Check time range has data
- Ensure backend is running and generating metrics

See [docs/monitoring.md#troubleshooting](../docs/monitoring.md#troubleshooting) for more details.
