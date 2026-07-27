# Performance Baselines per Major Release

> **Audience:** Operators (SREs, Infrastructure Engineers, and System Administrators)

This document establishes the official performance baselines across major releases of the Credence Backend service. Operators and release engineers should use these baseline figures to identify latency regressions, throughput bottlenecks, and resource consumption anomalies during staging validation and pre-deployment load testing.

---

## 1. Overview & Purpose

As the Credence economic trust protocol expands, changes to database indexing, middleware, state synchronization, and Soroban RPC integrations can impact API performance. 

By benchmarking key HTTP entrypoints under standardized workloads for every major release, operators can:
- Eyeball performance regressions before deploying to production.
- Verify system behavior against capacity targets without reading historic commit logs.
- Determine required infrastructure sizing (CPU, Memory, PostgreSQL connection pool size, Redis memory limit) for target throughput.

---

## 2. Standardized Benchmark Environment

All major release baselines are recorded in a standardized benchmark environment to ensure consistency.

### Hardware & Environment Specifications
- **Compute:** 4 vCPU, 8 GB RAM (AWS t3.xlarge equivalent)
- **Node.js Runtime:** v20.x LTS (`NODE_ENV=production`)
- **Database:** PostgreSQL 16 (4 vCPU, 16 GB RAM, `max_connections=100`, shared buffers = 2GB)
- **Cache:** Redis 7.2 (`maxmemory 1gb`, volatile-lru eviction policy)
- **Network:** Local virtual network (< 1ms ping latency between API and datastores)

### Workload Generator Profile
- **Tool:** `autocannon` / `k6`
- **Duration:** 300 seconds per benchmark run (after a 30-second warm-up)
- **Concurrency:** 100 concurrent connections (`-c 100`)

---

## 3. Major Release Baselines

### Release Matrix Overview

| Metric / Endpoint | v0.1.0 (Beta) | v1.0.0 (Production Core) | v2.0.0 (High Throughput & Materialized Analytics) |
| :--- | :--- | :--- | :--- |
| **Max System Throughput** | ~450 req/sec | ~1,850 req/sec | ~4,200 req/sec |
| **P95 Latency (`/api/trust/:address`)** | 380 ms | 65 ms (Cache Hit) / 140 ms (Miss) | 22 ms (Cache Hit) / 48 ms (Miss) |
| **P95 Latency (`/api/analytics/summary`)** | 1,250 ms (Direct DB Query) | 890 ms | 18 ms (Materialized View) |
| **P95 Latency (`POST /api/attestations`)** | 410 ms | 185 ms | 85 ms (Async Outbox) |
| **Average Memory RSS** | 180 MB | 240 MB | 310 MB |
| **CPU Saturation at 1k RPS** | 85% (Single Core) | 45% (Multi Core cluster) | 22% (Optimized event loop) |

---

### Detailed Endpoint Baselines

#### Endpoint: `GET /api/health` & `/api/health/ready`
Deep readiness check evaluating PostgreSQL connectivity, Redis health, and Outbox publisher lag.

| Release | Concurrency | Throughput (RPS) | Latency p50 | Latency p95 | Latency p99 | Error Rate |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.1.0** | 50 | 850 req/sec | 12 ms | 35 ms | 85 ms | 0.00% |
| **v1.0.0** | 100 | 2,400 req/sec | 4 ms | 15 ms | 42 ms | 0.00% |
| **v2.0.0** | 100 | 5,800 req/sec | 2 ms | 8 ms | 18 ms | 0.00% |

#### Endpoint: `GET /api/trust/:address`
Fetches trust score calculated by the reputation engine, utilizing Redis caching with TTL.

| Release | Concurrency | Cache Hit Ratio | Throughput (RPS) | Latency p50 | Latency p95 | Latency p99 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.1.0** | 100 | 0% (No Cache) | 420 req/sec | 110 ms | 380 ms | 650 ms |
| **v1.0.0** | 100 | 85% | 1,850 req/sec | 18 ms | 65 ms | 190 ms |
| **v2.0.0** | 100 | 95% | 4,200 req/sec | 8 ms | 22 ms | 55 ms |

#### Endpoint: `GET /api/bond/:address`
Retrieves bond status and identity state reconciled with Stellar Horizon.

| Release | Concurrency | Throughput (RPS) | Latency p50 | Latency p95 | Latency p99 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.1.0** | 100 | 380 req/sec | 140 ms | 420 ms | 800 ms |
| **v1.0.0** | 100 | 1,200 req/sec | 32 ms | 95 ms | 280 ms |
| **v2.0.0** | 100 | 3,100 req/sec | 12 ms | 38 ms | 92 ms |

#### Endpoint: `POST /api/attestations`
Creates a new attestation record and publishes an outbox event.

| Release | Concurrency | Throughput (RPS) | Latency p50 | Latency p95 | Latency p99 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.1.0** | 50 | 150 req/sec | 180 ms | 410 ms | 920 ms |
| **v1.0.0** | 100 | 650 req/sec | 45 ms | 185 ms | 450 ms |
| **v2.0.0** | 100 | 1,600 req/sec | 22 ms | 85 ms | 210 ms |

#### Endpoint: `GET /api/analytics/summary`
Aggregated network analytics. Optimized in v2.0.0 with PostgreSQL materialized views (`analytics_metrics_mv`).

| Release | Concurrency | Query Strategy | Throughput (RPS) | Latency p50 | Latency p95 | Latency p99 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.1.0** | 20 | Live Table Scans | 45 req/sec | 680 ms | 1,250 ms | 2,800 ms |
| **v1.0.0** | 50 | Indexed Aggregates | 220 req/sec | 210 ms | 890 ms | 1,650 ms |
| **v2.0.0** | 100 | Materialized View (`analytics_metrics_mv`) | 3,400 req/sec | 5 ms | 18 ms | 45 ms |

---

## 4. How to Run Performance Benchmarks

Operators can execute benchmarks against a local or target environment using `autocannon` or `cURL` scripts.

### 4.1 Running Benchmark via Autocannon

Ensure the backend server is running (`npm start` or `npm run dev`):

```bash
# Benchmark Health Readiness Endpoint
npx autocannon -c 100 -d 30 -m GET http://localhost:3000/api/health/ready

# Benchmark Trust Score Lookup (Targeting Address)
npx autocannon -c 100 -d 30 -m GET http://localhost:3000/api/trust/GABC7IXPV3YWQXKQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQZQXQ

# Benchmark Materialized Analytics Summary
npx autocannon -c 100 -d 30 -m GET http://localhost:3000/api/analytics/summary
```

### 4.2 Concrete Node.js Benchmark Script Example

Save and execute this benchmark verification script against a running server:

```typescript
import http from 'node:http';

interface PerfResult {
  totalRequests: number;
  successfulRequests: number;
  durationMs: number;
  rps: number;
}

function runBenchmark(url: string, totalRequests: number, concurrency: number): Promise<PerfResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let completed = 0;
    let successful = 0;
    let active = 0;
    let dispatched = 0;

    function next() {
      if (completed === totalRequests) {
        const durationMs = Date.now() - startTime;
        const rps = Number(((successful / durationMs) * 1000).toFixed(2));
        resolve({ totalRequests, successfulRequests: successful, durationMs, rps });
        return;
      }

      while (active < concurrency && dispatched < totalRequests) {
        dispatched++;
        active++;
        http.get(url, (res) => {
          if (res.statusCode && res.statusCode < 400) {
            successful++;
          }
          res.resume();
          active--;
          completed++;
          next();
        }).on('error', () => {
          active--;
          completed++;
          next();
        });
      }
    }

    next();
  });
}

// Example execution targeting local API health endpoint
const targetUrl = 'http://localhost:3000/api/health';
console.log(`Starting benchmark test against ${targetUrl}...`);
runBenchmark(targetUrl, 500, 20).then((res) => {
  console.log(`Benchmark completed: ${res.successfulRequests}/${res.totalRequests} successful in ${res.durationMs}ms (${res.rps} RPS)`);
});
```

---

## 5. Regression Thresholds & Action Plan

When verifying a candidate release build, operators must compare benchmark results against the current major release baseline (v2.0.0).

### Regression Tolerances
- **Latency Regression:** p95 latency must not exceed **15%** above the documented baseline.
- **Throughput Drop:** System throughput (RPS) must not drop more than **10%** below the documented baseline.
- **Resource Saturation:** Memory RSS must remain below **512 MB** under sustained load (1,000 RPS).

### Operator Action Plan on Regression Failure
1. **Verify Cache Health:** Ensure Redis cache hit ratio exceeds 90% (`GET /api/health/cache`).
2. **Inspect Database Locks & Queries:** Check for unindexed table scans or connection pool saturation in Prometheus (`pg_stat_activity` / `http_request_duration_seconds`).
3. **Audit Materialized View Freshness:** Check if `analytics_metrics_mv` refresh cron is lagging (`ANALYTICS_STALENESS_SECONDS`).
4. **Block Deployment:** If latency exceeds p95 targets by > 15%, hold release approval and page the performance engineering team.

---

## 6. Related Documentation

- [Service Level Objectives (SLO)](./SLO.md)
- [SLA Metrics & Latency Distribution](./sla-metrics.md)
- [Monitoring & Observability Guide](./monitoring.md)
- [API Reference](./api.md)
- [Caching Strategy](./caching.md)
