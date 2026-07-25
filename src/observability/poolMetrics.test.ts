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

  it('calculates pool utilization percentage correctly', async () => {
    const registry = new client.Registry()

    // Mock pools with specific states
    const apiPool = {
      totalCount: 20,
      idleCount: 5,
      waitingCount: 0,
    } as Pool

    const workerPool = {
      totalCount: 10,
      idleCount: 2,
      waitingCount: 0,
    } as Pool

    registerPoolMetrics(registry, apiPool, workerPool)

    const metricsStr = await registry.metrics()

    // API pool: 20 total, 5 idle, 15 active = 75% utilization
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="api"} 75')

    // Worker pool: 10 total, 2 idle, 8 active = 80% utilization
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="worker"} 80')
  })

  it('handles high pool utilization (alert threshold)', async () => {
    const registry = new client.Registry()

    // Mock pools at high utilization
    const apiPool = {
      totalCount: 20,
      idleCount: 2,
      waitingCount: 0,
    } as Pool

    const workerPool = {
      totalCount: 10,
      idleCount: 1,
      waitingCount: 0,
    } as Pool

    registerPoolMetrics(registry, apiPool, workerPool)

    const metricsStr = await registry.metrics()

    // API pool: 20 total, 2 idle, 18 active = 90% utilization (exceeds 80% threshold)
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="api"} 90')

    // Worker pool: 10 total, 1 idle, 9 active = 90% utilization (exceeds 80% threshold)
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="worker"} 90')
  })

  it('handles edge case of empty pool (zero total)', async () => {
    const registry = new client.Registry()

    // Mock pools with zero total count
    const apiPool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    } as Pool

    const workerPool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
    } as Pool

    registerPoolMetrics(registry, apiPool, workerPool)

    const metricsStr = await registry.metrics()

    // Should report 0% utilization when pool is empty
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="api"} 0')
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="worker"} 0')
  })

  it('updates pool utilization on dynamic pool changes', async () => {
    const registry = new client.Registry()

    const apiPool = {
      totalCount: 20,
      idleCount: 10,
      waitingCount: 0,
    } as Pool

    const workerPool = {
      totalCount: 10,
      idleCount: 5,
      waitingCount: 0,
    } as Pool

    registerPoolMetrics(registry, apiPool, workerPool)

    let metricsStr = await registry.metrics()

    // Initial: 50% utilization
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="api"} 50')

    // Simulate pool usage increase
    apiPool.idleCount = 2

    metricsStr = await registry.metrics()

    // Updated: 90% utilization
    expect(metricsStr).toContain('pg_pool_utilization_percent{pool="api"} 90')
  })
})
