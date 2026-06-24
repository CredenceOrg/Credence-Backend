/**
 * PostgreSQL connection pool saturation metrics.
 *
 * Registers Prometheus gauges for total, idle, and waiting connection counts
 * on both the API and worker pools. Uses collect() callbacks so values are
 * sampled at scrape time rather than polled on a timer.
 */

import type { Pool } from "pg";
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
}
