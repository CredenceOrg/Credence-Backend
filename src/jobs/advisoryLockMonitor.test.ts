import { beforeEach, describe, expect, it, vi } from 'vitest'
import client from 'prom-client'
import {
  collectStaleAdvisoryLocks,
  getStaleAdvisoryLocks,
  registerAdvisoryLockMetrics,
  resetAdvisoryLockMetrics,
} from './advisoryLockMonitor.js'

const makeFakePool = (rows: Array<Record<string, unknown>>) => ({
  query: vi.fn().mockResolvedValue({ rows }),
})

describe('advisoryLockMonitor', () => {
  beforeEach(() => {
    resetAdvisoryLockMetrics()
  })

  it('registers the advisory lock age gauge in a provided registry', async () => {
    const registry = new client.Registry()
    const gauge = registerAdvisoryLockMetrics(registry)

    const metrics = await registry.getMetricsAsJSON()
    expect(metrics.find((metric) => metric.name === 'pg_advisory_lock_age_seconds')).toBeDefined()
    expect(gauge).toBeDefined()
  })

  it('returns stale advisory locks older than the threshold', async () => {
    const pool = makeFakePool([
      {
        lock_id: '1:0',
        pid: 123,
        query: 'SELECT pg_advisory_lock(1)',
        database: 'testdb',
        age_seconds: '301.5',
      },
    ])

    const staleLocks = await getStaleAdvisoryLocks(pool as any, 300)

    expect(staleLocks).toEqual([
      {
        lockId: '1:0',
        pid: 123,
        query: 'SELECT pg_advisory_lock(1)',
        database: 'testdb',
        ageSeconds: 301.5,
      },
    ])
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [300])
  })

  it('collects stale advisory lock ages and emits gauge values', async () => {
    const pool = makeFakePool([
      {
        lock_id: '2:1',
        pid: 456,
        query: 'SELECT pg_advisory_lock(2, 1)',
        database: 'prod',
        age_seconds: 600,
      },
    ])
    const registry = new client.Registry()
    registerAdvisoryLockMetrics(registry)

    const staleLocks = await collectStaleAdvisoryLocks(pool as any, 300)
    expect(staleLocks).toHaveLength(1)
    expect(staleLocks[0]).toMatchObject({ lockId: '2:1', pid: 456, ageSeconds: 600 })

    const metrics = await registry.getMetricsAsJSON()
    const gaugeMetric = metrics.find((metric) => metric.name === 'pg_advisory_lock_age_seconds')
    expect(gaugeMetric).toBeDefined()
    expect(gaugeMetric?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 600,
          labels: {
            lock_id: '2:1',
            pid: '456',
            database: 'prod',
            query: 'SELECT pg_advisory_lock(2, 1)',
          },
        }),
      ])
    )
  })
})
