# Deployment Cutover, Health Gates & Rollback

**Audience:** Operators and on-call engineers running or supervising a production deploy.

**Last updated:** 2026-07-24

This document explains how a new build of `credence-backend` replaces the running one in Kubernetes without downtime, exactly what the cluster checks before it trusts a new pod with traffic, and how to trigger a rollback when it doesn't check out. It assumes the manifests in [`k8s/`](../k8s/) — see [docs/k8s.md](k8s.md) for the manifest reference and initial-deploy quick start. This doc goes one level deeper: the sequencing of a cutover, the exact health-gate thresholds, and the rollback decision + commands.

---

## Overview

Cutover is a **rolling update**, not a blue/green swap: `k8s/deployment.yaml` sets

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
```

With `replicas: 2`, `maxSurge: 1` lets the Deployment create **one extra pod above the desired count** while the update is in progress, and `maxUnavailable: 0` means **no existing pod is removed until its replacement is proven Ready**. Traffic only shifts to a new pod once that pod passes the readiness gate described below — old pods keep serving until then. This is what makes the health probes a real gate rather than a formality: a broken new build simply never gets added to the Service's endpoint list, and the old build keeps handling 100% of traffic indefinitely.

---

## Prerequisites

- [ ] New image built and pushed to the registry (default `ghcr.io/credenceorg/credence-backend`), tagged with the Git SHA you're deploying
- [ ] `kubectl` context pointed at the target cluster/namespace (`credence`)
- [ ] Migrations for this release already applied (`npm run migrate`) — cutover does not run migrations; see [Database Migrations](../README.md#database-migrations)
- [ ] Dashboards open: error rate and p99 latency panels from [docs/OBSERVABILITY.md](OBSERVABILITY.md)
- [ ] You know the current revision, in case you need to roll back to it:
  ```bash
  kubectl rollout history deployment/credence-backend -n credence
  ```

---

## Cutover flow

### 1. Record the current state (rollback anchor)

```bash
kubectl rollout history deployment/credence-backend -n credence
# CHANGE-CAUSE column is empty unless you set it — do that now so history is legible:
kubectl annotate deployment/credence-backend -n credence \
  kubernetes.io/change-cause="deploy $(git rev-parse --short HEAD)" --overwrite
```

### 2. Trigger the update

```bash
kubectl set image deployment/credence-backend \
  credence-backend=ghcr.io/credenceorg/credence-backend:<new-sha-or-tag> \
  -n credence
```

This is the cutover trigger. Kubernetes immediately starts creating a new pod (up to `maxSurge: 1` above the 2 replicas already running).

### 3. Watch the rollout

```bash
kubectl rollout status deployment/credence-backend -n credence --timeout=180s
```

`rollout status` blocks until the update finishes or the timeout expires. Internally it is waiting for the same signal the health gate uses (see below) — a new pod reaching `Ready`. It does **not** by itself prove the new build is healthy under real traffic, only that it passed startup and readiness checks; watch the dashboards through the next step too.

### 4. Confirm the new build is actually serving

Every health response includes build metadata (`src/utils/version.ts`), so you can prove the rollout you triggered is the one taking traffic rather than trusting `kubectl` alone:

```bash
kubectl port-forward svc/credence-backend 8080:80 -n credence &
curl -s http://localhost:8080/api/health/live | jq '.version'
# {
#   "gitSha": "<new-sha>",
#   "buildTimestamp": "...",
#   "nodeVersion": "v20.x.x"
# }
```

Because the Service load-balances across whatever pods are currently in its endpoint list, repeat the request a few times during the rollout — you'll see a mix of old and new `gitSha` values until the old pods are fully drained.

### 5. Post-cutover verification

```bash
kubectl get pods -n credence -l app.kubernetes.io/name=credence-backend
# All pods should show 2/2 (or 1/1) READY and no RESTARTS climbing

curl -s http://localhost:8080/api/health | jq .
# "status": "ok" and every dependency "up" (or "not_configured" if intentionally unset)
```

Watch the error-rate and p99 latency panels for ~5–10 minutes after `rollout status` returns before considering the cutover done — the health gate proves the pod *can* serve, not that the new code behaves correctly under production load.

---

## Health-gate checks

Three separate probes, all defined in `k8s/deployment.yaml`, gate a pod from `Pending` → `Running` → actually receiving traffic:

| Probe | Path | Purpose | `initialDelaySeconds` | `periodSeconds` | `failureThreshold` | Effect on failure |
|---|---|---|---|---|---|---|
| **Startup** | `GET /api/health/live` | Give the container time to boot before liveness kicks in | 5s | 5s | 10 | Pod restarted if it never starts within ~50s |
| **Liveness** | `GET /api/health/live` | Process is alive (no dependency checks) | 10s | 15s | 3 | Pod **restarted** (kubelet kills and recreates the container) |
| **Readiness** | `GET /api/health/ready` | Dependencies (DB, Redis, workers) are actually usable | 5s | 10s | 3 | Pod **removed from the Service's endpoints** — no restart, no traffic |

The readiness probe is the one that gates cutover: with `failureThreshold: 3` and `periodSeconds: 10`, a new pod that never becomes ready is excluded from receiving traffic within ~30 seconds of failing, and — because `maxUnavailable: 0` — the corresponding old pod is never torn down. The rollout simply stalls with the new pod stuck `0/1 Ready` until you intervene.

### Reading the readiness response

`GET /api/health` (alias: `/api/health/ready`) returns:

```json
{
  "status": "ok",
  "service": "credence-backend",
  "version": { "gitSha": "...", "buildTimestamp": "...", "nodeVersion": "..." },
  "dependencies": {
    "postgres": { "status": "up", "latencyMs": 4 },
    "redis": { "status": "up", "latencyMs": 1 },
    "horizonListener": { "status": "up", "lagSeconds": 0 },
    "outboxPublisher": { "status": "up", "lagSeconds": 0 },
    "horizon": { "status": "up", "latencyMs": 120 }
  }
}
```

- `status: "ok"` → HTTP 200, pod is Ready.
- `status: "degraded"` → HTTP 200, pod is still Ready. One or more **optional** dependencies report `not_configured`. Traffic flows normally; this is informational.
- `status: "unhealthy"` → **HTTP 503**, pod is not Ready. At least one dependency reports `status: "down"`. This is what fails the readiness probe and blocks cutover.

Per-dependency breakdown (`GET /api/health/dependencies` returns just this object, same status codes):

| Dependency | `down` means | `not_configured` means |
|---|---|---|
| `postgres` | Connection/query failed | `DATABASE_URL` not set |
| `redis` | `PING` failed | `REDIS_URL` not set |
| `horizonListener` | Listener lease/heartbeat stale | Listener not enabled for this deployment |
| `outboxPublisher` | Publisher lease/heartbeat stale | Outbox publishing not enabled |
| `horizon` | Horizon/Soroban circuit breaker is OPEN | No Horizon client configured |

If a new pod is stuck failing readiness, `curl` its dependency breakdown directly (bypass the Service so you're hitting the specific pod):

```bash
kubectl get pods -n credence -l app.kubernetes.io/name=credence-backend
kubectl port-forward pod/<new-pod-name> 8080:3000 -n credence
curl -s http://localhost:8080/api/health/dependencies | jq .
```

That tells you which dependency is failing before you decide whether to fix forward or roll back.

---

## Rollback trigger

### When to trigger a rollback

Trigger a rollback — don't wait to diagnose in place — if any of these hold after cutover:

1. **Rollout never completes.** `kubectl rollout status` times out, or `kubectl get pods` shows the new pod stuck below `N/N Ready` for more than a couple of probe cycles (~1 minute).
2. **New pods crash-loop.** `RESTARTS` climbing on the new revision's pods (`kubectl get pods -l app.kubernetes.io/name=credence-backend`).
3. **Readiness flaps or stays `unhealthy`/503** on `/api/health` for the new pods after dependencies you expect to be up.
4. **Error rate or latency regresses** on the dashboards in [docs/OBSERVABILITY.md](OBSERVABILITY.md) once the new build starts taking traffic — most directly `CredenceTrustScoreHighErrorRate` or `HighLatencyP99` firing per [docs/RUNBOOK.md](RUNBOOK.md).

Note the built-in safety net: because `maxUnavailable: 0`, cases 1–3 above **cannot** take the service down by themselves — old pods keep serving until you act. Case 4 is the dangerous one, because it means the new pods *are* passing the health gate but are still wrong; the health gate only proves dependencies are reachable, not that business logic is correct.

### How to trigger it

```bash
# Abort an in-progress rollout and revert to the previous ReplicaSet:
kubectl rollout undo deployment/credence-backend -n credence

# Or roll back to a specific known-good revision (see history from Step 1):
kubectl rollout undo deployment/credence-backend -n credence --to-revision=<N>

# Watch it take effect the same way you watched the forward rollout:
kubectl rollout status deployment/credence-backend -n credence --timeout=180s
```

`rollout undo` is itself a rolling update in reverse — it goes through the same `maxSurge`/`maxUnavailable` and readiness-gate mechanics described above, so the rollback is gated exactly like the original cutover was.

### Verify the rollback

```bash
curl -s http://localhost:8080/api/health/live | jq '.version.gitSha'
# should print the previous (known-good) SHA

curl -s http://localhost:8080/api/health | jq '.status'
# "ok"
```

Then follow [docs/RUNBOOK.md](RUNBOOK.md) escalation steps if the rollback was triggered by an alert (case 4) — file an incident ticket, since rolling back does not by itself explain *why* the new build regressed.

**Rollback checklist:**

- [ ] `kubectl rollout undo` issued and `rollout status` confirms completion
- [ ] `gitSha` on `/api/health/live` matches the previous known-good revision
- [ ] `/api/health` reports `"status": "ok"`
- [ ] Error rate / latency back to baseline on dashboards
- [ ] Incident ticket filed if triggered by a production regression (case 4 above)
- [ ] Root cause identified before re-attempting the cutover

---

## Related documentation

- [docs/k8s.md](k8s.md) — manifest reference and first-time deploy
- [docs/OBSERVABILITY.md](OBSERVABILITY.md) — dashboards and alerts to watch during/after cutover
- [docs/RUNBOOK.md](RUNBOOK.md) — on-call diagnostics and escalation if a rollback doesn't resolve the issue
- [docs/graceful-shutdown.md](graceful-shutdown.md) — how a pod drains in-flight requests when it's removed during a rollout
- [README.md § Health endpoint (detailed)](../README.md#health-endpoint-detailed) — full readiness/liveness response shape
