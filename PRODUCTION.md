# Production Configuration

## Memory Limits

To prevent the application from exceeding memory limits and crashing, set the `NODE_MAX_OLD_SPACE_SIZE_MB` environment variable. This configures Node.js's `--max-old-space-size` flag.

### Recommended Configuration

- For containerized deployments (Docker/Kubernetes): Set to 80-90% of your container's memory limit
- Example: If your container memory limit is 2Gi, set `NODE_MAX_OLD_SPACE_SIZE_MB=1800`

### Examples

#### Docker
```bash
docker run -e NODE_MAX_OLD_SPACE_SIZE_MB=1800 credence-backend
```

#### Kubernetes
```yaml
spec:
  containers:
  - name: credence-backend
    env:
    - name: NODE_MAX_OLD_SPACE_SIZE_MB
      value: "1800"
    resources:
      requests:
        memory: "2Gi"
      limits:
        memory: "2Gi"
```

## Per-tenant Database Connection Budget

Set `DB_TENANT_CONNECTION_BUDGET` to cap how many concurrent PostgreSQL clients a single tenant can hold at once. This is a defence-in-depth control that prevents one noisy tenant from draining the shared pool and affecting other tenants.

### Recommended Configuration

- Default: `5`
- Increase only when you have strong evidence the workload needs more per-tenant concurrency.
- Keep the value lower than the global `DB_POOL_MAX` to preserve headroom for other tenants.

### Example

```bash
docker run -e DB_TENANT_CONNECTION_BUDGET=5 -e DB_POOL_MAX=20 credence-backend
```

## Metrics for OOM Detection

The application exposes `oom_events_total` counter metric that increments when an out-of-memory event is detected. Configure alerts for this metric in your monitoring system.
