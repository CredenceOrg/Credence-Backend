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

## Metrics for OOM Detection

The application exposes `oom_events_total` counter metric that increments when an out-of-memory event is detected. Configure alerts for this metric in your monitoring system.
