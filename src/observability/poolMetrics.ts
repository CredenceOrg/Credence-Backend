/**
 * PostgreSQL connection pool saturation metrics.
 *
 * Registers Prometheus gauges for total, idle, and waiting connection counts
 * on both the API and worker pools. Uses collect() callbacks so values are
 * sampled at scrape time rather than polled on a timer.
 */

import type { Pool } from "pg";
import type { LRUCache } from "lru-cache";
import client from "prom-client";

/**
 * Register pool saturation gauges for both the API and worker pools.
 *
 * @param registry - Prometheus registry to register metrics with.
 * @param apiPool  - Primary API connection pool.
 * @param workerPool - Background worker connection pool.
 */
export function registerPoolMetrics(
  registry: client.Registry,
  apiPool: Pool,
  workerPool: Pool,
): void {
  new client.Gauge({
    name: "pg_pool_total_count",
    help: "Total number of clients in the pool (active + idle)",
    labelNames: ["pool"] as const,
    registers: [registry],
    collect() {
      this.set({ pool: "api" }, apiPool.totalCount);
      this.set({ pool: "worker" }, workerPool.totalCount);
    },
  });

  new client.Gauge({
    name: "pg_pool_idle_count",
    help: "Number of idle clients in the pool",
    labelNames: ["pool"] as const,
    registers: [registry],
    collect() {
      this.set({ pool: "api" }, apiPool.idleCount);
      this.set({ pool: "worker" }, workerPool.idleCount);
    },
  });

  new client.Gauge({
    name: "pg_pool_waiting_count",
    help: "Number of queued requests waiting for a pool connection",
    labelNames: ["pool"] as const,
    registers: [registry],
    collect() {
      this.set({ pool: "api" }, apiPool.waitingCount);
      this.set({ pool: "worker" }, workerPool.waitingCount);
    },
  });

  new client.Gauge({
    name: "pg_pool_utilization_percent",
    help: "Percentage of pool capacity in use (active connections / total connections * 100)",
    labelNames: ["pool"] as const,
    registers: [registry],
    collect() {
      const apiUtilization = apiPool.totalCount > 0
        ? ((apiPool.totalCount - apiPool.idleCount) / apiPool.totalCount) * 100
        : 0;
      const workerUtilization = workerPool.totalCount > 0
        ? ((workerPool.totalCount - workerPool.idleCount) / workerPool.totalCount) * 100
        : 0;
      this.set({ pool: "api" }, apiUtilization);
      this.set({ pool: "worker" }, workerUtilization);
    },
  });
}

/**
 * Register the prepared-statement cache size gauge for each pool.
 *
 * Each pool (api/worker/replica) keeps its own bounded LRU cache mapping
 * query text to a stable prepared-statement name (see
 * `instrumentPreparedStatementCache` in src/db/pool.ts). `size` is sampled
 * at scrape time via `collect()` rather than pushed on every query.
 *
 * Sustained values at the configured `DB_PREPARED_STATEMENT_CACHE_MAX`
 * indicate cache-miss thrash: more distinct query shapes are hitting the
 * pool than the cache can retain, so queries are being evicted (and falling
 * back to unnamed/re-parsed execution) before they're ever reused.
 *
 * @param registry - Prometheus registry to register the metric with.
 * @param caches - Prepared-statement caches keyed by pool name.
 */
export function registerPreparedStatementCacheMetrics(
  registry: client.Registry,
  caches: { api: LRUCache<string, string>; worker: LRUCache<string, string>; replica: LRUCache<string, string> },
): void {
  new client.Gauge({
    name: "db_prepared_statement_cache_size",
    help: "Current number of distinct query shapes tracked in the prepared-statement name cache, per pool. Sustained values at the configured DB_PREPARED_STATEMENT_CACHE_MAX indicate cache-miss thrash.",
    labelNames: ["pool"] as const,
    registers: [registry],
    collect() {
      this.set({ pool: "api" }, caches.api.size);
      this.set({ pool: "worker" }, caches.worker.size);
      this.set({ pool: "replica" }, caches.replica.size);
    },
  });
}
