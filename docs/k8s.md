# Kubernetes Deployment Guide

Deploy the Credence Backend to a Kubernetes cluster.

## Prerequisites

- Kubernetes cluster (1.24+)
- `kubectl` configured for your cluster
- Container image pushed to a registry (default: `ghcr.io/credenceorg/credence-backend:latest`)

## Quick Start

```bash
# 1. Apply all manifests at once via Kustomize
kubectl apply -k k8s/

# 2. Check rollout status
kubectl rollout status deployment/credence-backend -n credence

# 3. Verify pods are running
kubectl get pods -n credence
```

## Manifests

| File | Kind | Description |
|---|---|---|
| `k8s/namespace.yaml` | Namespace | `credence` namespace for all resources |
| `k8s/configmap.yaml` | ConfigMap | Non-secret config (PORT, NODE_ENV, DATABASE_URL, REDIS_URL) |
| `k8s/secret.yaml` | Secret | Placeholder for sensitive values (passwords, API keys) |
| `k8s/deployment.yaml` | Deployment | 2-replica deployment with resource limits and health probes |
| `k8s/service.yaml` | Service | ClusterIP service exposing port 80 → container port 3000 |
| `k8s/kustomization.yaml` | Kustomization | Applies all resources in the correct order |

## Configuration

### ConfigMap (`credence-backend-config`)

Edit `k8s/configmap.yaml` or override at apply time:

| Key | Default | Description |
|---|---|---|
| `PORT` | `3000` | Express server port |
| `NODE_ENV` | `production` | Node environment |
| `DATABASE_URL` | `postgresql://credence:CHANGEME@postgres:5432/credence` | PostgreSQL connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `LOG_LEVEL` | `info` | Application log level |

### Secret (`credence-backend-secret`)

**Do not commit real secrets.** Create them manually:

```bash
kubectl create secret generic credence-backend-secret \
  --from-literal=DATABASE_PASSWORD=<real-password> \
  --from-literal=API_KEY=<real-api-key> \
  -n credence
```

Or use a secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.).

## Health Probes

The deployment uses the existing health endpoints:

| Probe | Endpoint | Purpose |
|---|---|---|
| **Liveness** | `GET /api/health/live` | Restart pod if process hangs |
| **Readiness** | `GET /api/health/ready` | Remove from Service if dependencies are down |
| **Startup** | `GET /api/health/live` | Allow time for container startup |

## Scaling

```bash
# Manual scaling
kubectl scale deployment/credence-backend --replicas=4 -n credence

# Or use a HorizontalPodAutoscaler
kubectl autoscale deployment/credence-backend \
  --min=2 --max=10 --cpu-percent=70 -n credence
```

## Resource Limits

| | CPU | Memory |
|---|---|---|
| **Request** | 100m | 128Mi |
| **Limit** | 500m | 512Mi |

Adjust in `k8s/deployment.yaml` based on observed usage.

## Exposing Externally

The default Service type is `ClusterIP` (internal only). Options for external access:

### Option A — LoadBalancer

```yaml
# In k8s/service.yaml, change:
spec:
  type: LoadBalancer
```

### Option B — Ingress (recommended)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: credence-backend
  namespace: credence
spec:
  rules:
    - host: api.credence.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: credence-backend
                port:
                  name: http
```

## Updating the Image

```bash
kubectl set image deployment/credence-backend \
  credence-backend=ghcr.io/credenceorg/credence-backend:v1.2.3 \
  -n credence
```

## Teardown

```bash
kubectl delete -k k8s/
```
