import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Pool } from 'pg'
import { pool, workerPool, TenantConnectionBudgetError, __poolTestHooks } from './pool.js'
import { runWithTenant } from '../utils/tenantContext.js'

describe('Pool Tenant Connection Budgeting', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    __poolTestHooks.clearTenantConnectionCounts()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = envSnapshot
    __poolTestHooks.clearTenantConnectionCounts()
    vi.restoreAllMocks()
  })

  it('pool.query resolves both outside and inside a tenant context and releases client exactly once', async () => {
    const fakeClientRelease = vi.fn()
    const fakeClient = {
      query: vi.fn((text: string, values: any, cb?: any) => {
        const callback = typeof values === 'function' ? values : cb
        const res = { rows: [{ num: 1 }] }
        if (typeof callback === 'function') {
          callback(null, res)
        }
        return Promise.resolve(res)
      }),
      release: fakeClientRelease,
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      emit: vi.fn(),
    }

    vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (cb?: any) {
      if (typeof cb === 'function') {
        cb(null, fakeClient, fakeClientRelease)
        return
      }
      return Promise.resolve(fakeClient as any)
    })

    // Outside tenant context
    const res1 = await pool.query('SELECT 1')
    expect(res1.rows).toEqual([{ num: 1 }])
    expect(fakeClientRelease).toHaveBeenCalledTimes(1)
    expect(__poolTestHooks.getTenantConnectionCount('tenant-1')).toBe(0)

    // Inside tenant context
    const res2 = await runWithTenant('tenant-1', async () => {
      return await pool.query('SELECT 1')
    })
    expect(res2.rows).toEqual([{ num: 1 }])
    expect(fakeClientRelease).toHaveBeenCalledTimes(2)
    expect(__poolTestHooks.getTenantConnectionCount('tenant-1')).toBe(0)
  })

  it('pool.connect with callback invokes callback exactly once and handles errors without unhandled rejections', async () => {
    const unhandledRejections: any[] = []
    const rejectionHandler = (reason: any) => {
      unhandledRejections.push(reason)
    }
    process.on('unhandledRejection', rejectionHandler)

    try {
      const fakeClientRelease = vi.fn()
      const fakeClient = { release: fakeClientRelease }

      // 1. Success case
      vi.spyOn(Pool.prototype, 'connect').mockImplementationOnce(function (cb?: any) {
        cb(null, fakeClient, fakeClientRelease)
      })

      let successCallbackCount = 0
      await new Promise<void>((resolve) => {
        runWithTenant('tenant-cb-success', () => {
          pool.connect((err, client, done) => {
            successCallbackCount++
            expect(err).toBeUndefined()
            expect(client).toBeDefined()
            expect(typeof done).toBe('function')
            done()
            resolve()
          })
        })
      })

      expect(successCallbackCount).toBe(1)
      expect(fakeClientRelease).toHaveBeenCalledTimes(1)
      expect(__poolTestHooks.getTenantConnectionCount('tenant-cb-success')).toBe(0)

      // 2. Failure case
      const connectionError = new Error('ECONNREFUSED connect')
      vi.spyOn(Pool.prototype, 'connect').mockImplementationOnce(function (cb?: any) {
        cb(connectionError, undefined, () => {})
      })

      let failureCallbackCount = 0
      await new Promise<void>((resolve) => {
        runWithTenant('tenant-cb-fail', () => {
          pool.connect((err, client, done) => {
            failureCallbackCount++
            expect(err).toBe(connectionError)
            expect(client).toBeUndefined()
            resolve()
          })
        })
      })

      expect(failureCallbackCount).toBe(1)
      expect(__poolTestHooks.getTenantConnectionCount('tenant-cb-fail')).toBe(0)

      // Allow tick for any unhandled rejection to surface
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandledRejections).toHaveLength(0)
    } finally {
      process.removeListener('unhandledRejection', rejectionHandler)
    }
  })

  it('enforces budget of 5 with 20 concurrent connect() calls and resets count to 0 after releases', async () => {
    const budget = __poolTestHooks.getTenantConnectionBudget() // Defaults to POOL_MAX/4 = 5
    expect(budget).toBe(5)

    const clients: any[] = []
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      const client = { release: vi.fn() }
      clients.push(client)
      return client as any
    })

    const results = await runWithTenant('tenant-concurrency', async () => {
      const promises = Array.from({ length: 20 }, () => pool.connect())
      return await Promise.allSettled(promises)
    })

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[]
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

    expect(fulfilled).toHaveLength(5)
    expect(rejected).toHaveLength(15)

    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(TenantConnectionBudgetError)
      expect(r.reason.tenantId).toBe('tenant-concurrency')
      expect(r.reason.limit).toBe(5)
    }

    expect(__poolTestHooks.getTenantConnectionCount('tenant-concurrency')).toBe(5)

    // Release all 5 clients
    for (const f of fulfilled) {
      f.value.release()
    }

    expect(__poolTestHooks.getTenantConnectionCount('tenant-concurrency')).toBe(0)
  })

  it('failed underlying connect does not leak a budget slot', async () => {
    vi.spyOn(Pool.prototype, 'connect').mockRejectedValue(new Error('transient pool error'))

    for (let i = 0; i < 10; i++) {
      await expect(
        runWithTenant('tenant-retry-slot', () => pool.connect())
      ).rejects.toThrow('transient pool error')
    }

    expect(__poolTestHooks.getTenantConnectionCount('tenant-retry-slot')).toBe(0)

    // Now succeeding connects should get full budget
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ release: vi.fn() } as any)

    const activeClients: any[] = []
    for (let i = 0; i < 5; i++) {
      const client = await runWithTenant('tenant-retry-slot', () => pool.connect())
      activeClients.push(client)
    }

    expect(__poolTestHooks.getTenantConnectionCount('tenant-retry-slot')).toBe(5)

    // 6th should reject
    await expect(
      runWithTenant('tenant-retry-slot', () => pool.connect())
    ).rejects.toBeInstanceOf(TenantConnectionBudgetError)

    // Release them
    for (const c of activeClients) {
      c.release()
    }
    expect(__poolTestHooks.getTenantConnectionCount('tenant-retry-slot')).toBe(0)
  })

  it('calling release() twice on the same client leaves count at 0 and does not free another slot', async () => {
    let connectCount = 0
    vi.spyOn(Pool.prototype, 'connect').mockImplementation(async () => {
      connectCount++
      return { id: connectCount, release: vi.fn() } as any
    })

    const client1 = await runWithTenant('tenant-double-rel', () => pool.connect())
    const client2 = await runWithTenant('tenant-double-rel', () => pool.connect())

    expect(__poolTestHooks.getTenantConnectionCount('tenant-double-rel')).toBe(2)

    // Double release client1
    client1.release()
    client1.release()

    // Client2 should still occupy 1 slot!
    expect(__poolTestHooks.getTenantConnectionCount('tenant-double-rel')).toBe(1)

    // Release client2
    client2.release()
    expect(__poolTestHooks.getTenantConnectionCount('tenant-double-rel')).toBe(0)

    // Additional releases must never drive count negative
    client2.release()
    client1.release()
    expect(__poolTestHooks.getTenantConnectionCount('tenant-double-rel')).toBe(0)
  })

  it('exhausting budget on workerPool does not affect pool for the same tenant', async () => {
    const budget = __poolTestHooks.getTenantConnectionBudget()
    vi.spyOn(Pool.prototype, 'connect').mockResolvedValue({ release: vi.fn() } as any)

    const workerClients: any[] = []
    for (let i = 0; i < budget; i++) {
      const client = await runWithTenant('tenant-isolated-pools', () => workerPool.connect())
      workerClients.push(client)
    }

    expect(__poolTestHooks.getTenantConnectionCount('tenant-isolated-pools', workerPool)).toBe(budget)
    expect(__poolTestHooks.getTenantConnectionCount('tenant-isolated-pools', pool)).toBe(0)

    // workerPool should reject next connect
    await expect(
      runWithTenant('tenant-isolated-pools', () => workerPool.connect())
    ).rejects.toBeInstanceOf(TenantConnectionBudgetError)

    // But primary pool should still have full budget available!
    const poolClient = await runWithTenant('tenant-isolated-pools', () => pool.connect())
    expect(__poolTestHooks.getTenantConnectionCount('tenant-isolated-pools', pool)).toBe(1)

    // Clean up
    poolClient.release()
    for (const c of workerClients) {
      c.release()
    }
    expect(__poolTestHooks.getTenantConnectionCount('tenant-isolated-pools', workerPool)).toBe(0)
    expect(__poolTestHooks.getTenantConnectionCount('tenant-isolated-pools', pool)).toBe(0)
  })
})
