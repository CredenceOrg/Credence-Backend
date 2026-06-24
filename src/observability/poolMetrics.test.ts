import { describe, it, expect, vi } from 'vitest'
import client from 'prom-client'
import { registerPoolMetrics } from './poolMetrics.js'
import type { Pool } from 'pg'

describe('Pool Metrics Exporter', () => {
  it('registers pool saturation gauges and reports correct values', async () => {
    const registry = new client.Registry()

    // Mock pools with specific states
    const apiPool = {
      totalCount: 15,
      idleCount: 5,
      waitingCount: 2,
    } as Pool

    const workerPool = {
      totalCount: 4,
      idleCount: 1,
      waitingCount: 0,
    } as Pool

    registerPoolMetrics(registry, apiPool, workerPool)

    const metricsStr = await registry.metrics()

    // API pool metrics
    expect(metricsStr).toContain('pg_pool_total_count{pool="api"} 15')
    expect(metricsStr).toContain('pg_pool_idle_count{pool="api"} 5')
    expect(metricsStr).toContain('pg_pool_waiting_count{pool="api"} 2')

    // Worker pool metrics
    expect(metricsStr).toContain('pg_pool_total_count{pool="worker"} 4')
    expect(metricsStr).toContain('pg_pool_idle_count{pool="worker"} 1')
    expect(metricsStr).toContain('pg_pool_waiting_count{pool="worker"} 0')

    // Dynamic updates via collect()
    apiPool.totalCount = 20
    apiPool.waitingCount = 5

    const updatedMetricsStr = await registry.metrics()
    expect(updatedMetricsStr).toContain('pg_pool_total_count{pool="api"} 20')
    expect(updatedMetricsStr).toContain('pg_pool_waiting_count{pool="api"} 5')
  })
})
