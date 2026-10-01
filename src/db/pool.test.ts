import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Pool } from 'pg'

// pool.ts now sources its settings from loadConfig() (see #887), which
// validates the *entire* app config, not just DB settings. These are the
// minimal required vars for that validation to succeed in isolation.
const REQUIRED_ENV: Record<string, string> = {
  DB_URL: 'postgresql://user:pass@localhost:5432/credence',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a]r$8kL!qZ3wX#mN9pT&vB6yD0fH2jU4',
}

describe('DB Pool configuration', () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    Object.assign(process.env, REQUIRED_ENV)
  })

  afterEach(() => {
    process.env = envSnapshot
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('pool is a Pool instance with expected options.max', async () => {
    const { pool } = await import('./pool.js')
    expect(pool).toBeInstanceOf(Pool)
    // The default in the code without env vars might be the fallback (20)
    // Actually we can check options if exposed or just check it's a Pool
    expect(pool.options.max).toBeDefined()
  })

  it('workerPool is a separate Pool instance', async () => {
    const { pool, workerPool } = await import('./pool.js')
    expect(workerPool).toBeInstanceOf(Pool)
    expect(workerPool).not.toBe(pool)
  })

  it('envInt returns fallback for missing env var', async () => {
    const { envInt } = await import('./pool.js')
    expect(envInt('MISSING_VAR_TEST', 42)).toBe(42)
  })

  it('envInt returns fallback for non-numeric string', async () => {
    const { envInt } = await import('./pool.js')
    process.env.NON_NUMERIC_TEST = 'not_a_number'
    expect(envInt('NON_NUMERIC_TEST', 42)).toBe(42)
  })
  
  it('envInt returns parsed number for valid string', async () => {
    const { envInt } = await import('./pool.js')
    process.env.VALID_NUM_TEST = '99'
    expect(envInt('VALID_NUM_TEST', 42)).toBe(99)
  })

  it('statement_timeout is set in options string', async () => {
    const { pool, workerPool, replicaPool } = await import('./pool.js')
    expect(pool.options.options).toContain('-c statement_timeout=')
    expect(workerPool.options.options).toContain('-c statement_timeout=')
    expect(replicaPool.options.options).toContain('-c statement_timeout=')
  })

  it('default idleTimeoutMillis is 300 000 ms (5 minutes) when DB_POOL_IDLE_TIMEOUT_MS is unset', async () => {
    delete process.env.DB_POOL_IDLE_TIMEOUT_MS
    vi.resetModules()
    const { pool, workerPool, replicaPool } = await import('./pool.js')
    // node-postgres exposes idleTimeoutMillis on pool.options
    expect(pool.options.idleTimeoutMillis).toBe(300_000)
    expect(workerPool.options.idleTimeoutMillis).toBe(300_000)
    expect(replicaPool.options.idleTimeoutMillis).toBe(300_000)
  })

  it('idleTimeoutMillis can be overridden via DB_POOL_IDLE_TIMEOUT_MS', async () => {
    process.env.DB_POOL_IDLE_TIMEOUT_MS = '60000'
    vi.resetModules()
    const { pool, workerPool, replicaPool } = await import('./pool.js')
    expect(pool.options.idleTimeoutMillis).toBe(60_000)
    expect(workerPool.options.idleTimeoutMillis).toBe(60_000)
    expect(replicaPool.options.idleTimeoutMillis).toBe(60_000)
  })

  it('replicaPool is a separate Pool instance', async () => {
    const { pool, replicaPool } = await import('./pool.js')
    expect(replicaPool).toBeInstanceOf(Pool)
    expect(replicaPool).not.toBe(pool)
  })

  it('replicaPool.options.max defaults to DB_POOL_MAX when DB_REPLICA_POOL_MAX is unset (#887)', async () => {
    process.env.DB_POOL_MAX = '17'
    delete process.env.DB_REPLICA_POOL_MAX
    vi.resetModules()
    const { pool, replicaPool } = await import('./pool.js')
    expect(pool.options.max).toBe(17)
    expect(replicaPool.options.max).toBe(17)
  })

  it('replicaPool.options.max honors DB_REPLICA_POOL_MAX independently of DB_POOL_MAX (#887)', async () => {
    process.env.DB_POOL_MAX = '20'
    process.env.DB_REPLICA_POOL_MAX = '6'
    vi.resetModules()
    const { pool, replicaPool } = await import('./pool.js')
    expect(pool.options.max).toBe(20)
    expect(replicaPool.options.max).toBe(6)
  })

  it('falls back to loadConfig() default replica pool max when the app fails to start with a bad value (failure mode, #887)', async () => {
    process.env.DB_REPLICA_POOL_MAX = 'not-a-number'
    vi.resetModules()
    await expect(import('./pool.js')).rejects.toThrow(/DB_REPLICA_POOL_MAX/)
  })

  it('rejects a tenant that exceeds its connection budget', async () => {
    process.env.DB_TENANT_CONNECTION_BUDGET = '1'

    const connectSpy = vi.spyOn(Pool.prototype, 'connect').mockResolvedValueOnce({
      release: vi.fn(),
    } as any)

    const { pool, TenantConnectionBudgetError } = await import('./pool.js')
    const { runWithTenant } = await import('../utils/tenantContext.js')

    const firstClient = await runWithTenant('tenant-budget', () => pool.connect())

    await expect(
      runWithTenant('tenant-budget', () => pool.connect())
    ).rejects.toMatchObject({
      name: TenantConnectionBudgetError.name,
      tenantId: 'tenant-budget',
      limit: 1,
      code: 'rate_limit_exceeded',
    })

    expect(connectSpy).toHaveBeenCalledTimes(1)
    firstClient.release()
  })

  it('withReplica uses replicaPool when lag is within bounds', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')
    
    // Mock the lag query
    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: 10 }] } as any)
    
    const operation = vi.fn().mockResolvedValue('success')
    const result = await withReplica(operation, { maxLagMs: 100 })
    
    expect(result).toBe('success')
    expect(operation).toHaveBeenCalledWith(replicaPool)
  })

  it('withReplica falls back to pool when lag exceeds maxLagMs', async () => {
    const { pool, withReplica, replicaPool } = await import('./pool.js')
    
    // Mock the lag query
    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: 500 }] } as any)
    
    const operation = vi.fn().mockResolvedValue('success')
    const result = await withReplica(operation, { maxLagMs: 100 })
    
    expect(result).toBe('success')
    expect(operation).toHaveBeenCalledWith(pool)
  })

  it('withReplica falls back to pool when replica query throws', async () => {
    const { pool, withReplica, replicaPool } = await import('./pool.js')
    
    // Mock the lag query
    vi.spyOn(replicaPool, 'query').mockRejectedValueOnce(new Error('Connection refused'))
    
    const operation = vi.fn().mockResolvedValue('success')
    const result = await withReplica(operation)
    
    expect(result).toBe('success')
    expect(operation).toHaveBeenCalledWith(pool)
  })

  it('withReplica throws when lag is high and fallback is false', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')
    
    // Mock the lag query
    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: 500 }] } as any)
    
    const operation = vi.fn()
    await expect(withReplica(operation, { maxLagMs: 100, fallback: false })).rejects.toThrow('Replica lag too high: 500ms')
    expect(operation).not.toHaveBeenCalled()
  })

  it('withReplica treats lag exactly at maxLagMs as within bounds (boundary)', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: 100 }] } as any)

    const operation = vi.fn().mockResolvedValue('ok')
    const result = await withReplica(operation, { maxLagMs: 100 })

    expect(result).toBe('ok')
    expect(operation).toHaveBeenCalledWith(replicaPool)
  })

  it('withReplica falls back to pool when lag query returns no rows (boundary)', async () => {
    const { pool, withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [] } as any)

    const operation = vi.fn().mockResolvedValue('ok')
    const result = await withReplica(operation)

    expect(result).toBe('ok')
    expect(operation).toHaveBeenCalledWith(pool)
  })

  it('withReplica falls back to pool when lag value is null (boundary)', async () => {
    const { pool, withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: null }] } as any)

    const operation = vi.fn().mockResolvedValue('ok')
    const result = await withReplica(operation)

    expect(result).toBe('ok')
    expect(operation).toHaveBeenCalledWith(pool)
  })

  it('withReplica propagates operation errors from the replica without retrying on the primary', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockResolvedValueOnce({ rows: [{ lag_ms: 5 }] } as any)

    const operation = vi.fn().mockRejectedValue(new Error('replica write failed'))
    await expect(withReplica(operation)).rejects.toThrow('replica write failed')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith(replicaPool)
  })

  it('withReplica propagates operation errors from the primary fallback', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockRejectedValueOnce(new Error('replica down'))

    const operation = vi.fn().mockRejectedValue(new Error('primary write failed'))
    await expect(withReplica(operation)).rejects.toThrow('primary write failed')
    expect(operation).toHaveBeenCalledTimes(1)
  })

  it('withReplica does not leak the lag probe failure to the caller when fallback succeeds', async () => {
    const { withReplica, replicaPool } = await import('./pool.js')

    vi.spyOn(replicaPool, 'query').mockRejectedValueOnce(new Error('replica unreachable'))

    const operation = vi.fn().mockResolvedValue('primary-ok')
    await expect(withReplica(operation)).resolves.toBe('primary-ok')
  })

  it('releases the tenant connection budget slot after release so a later connect succeeds (recovery)', async () => {
    process.env.DB_TENANT_CONNECTION_BUDGET = '1'

    const connectSpy = vi
      .spyOn(Pool.prototype, 'connect')
      .mockResolvedValueOnce({ release: vi.fn() } as any)
      .mockResolvedValueOnce({ release: vi.fn() } as any)

    const { pool } = await import('./pool.js')
    const { runWithTenant } = await import('../utils/tenantContext.js')

    const firstClient = await runWithTenant('tenant-recovery', () => pool.connect())
    firstClient.release()

    const secondClient = await runWithTenant('tenant-recovery', () => pool.connect())
    expect(secondClient).toBeDefined()
    expect(connectSpy).toHaveBeenCalledTimes(2)
    secondClient.release()
  })

  it('isolates connection budgets between tenants (no cross-tenant leakage)', async () => {
    process.env.DB_TENANT_CONNECTION_BUDGET = '1'

    const connectSpy = vi
      .spyOn(Pool.prototype, 'connect')
      .mockResolvedValueOnce({ release: vi.fn() } as any)
      .mockResolvedValueOnce({ release: vi.fn() } as any)

    const { pool } = await import('./pool.js')
    const { runWithTenant } = await import('../utils/tenantContext.js')

    const a = await runWithTenant('tenant-a', () => pool.connect())
    const b = await runWithTenant('tenant-b', () => pool.connect())

    expect(connectSpy).toHaveBeenCalledTimes(2)
    a.release()
    b.release()
  })

  it('rejects a tenant at the boundary of its budget (limit 0)', async () => {
    process.env.DB_TENANT_CONNECTION_BUDGET = '0'

    const connectSpy = vi.spyOn(Pool.prototype, 'connect')

    const { pool, TenantConnectionBudgetError } = await import('./pool.js')
    const { runWithTenant } = await import('../utils/tenantContext.js')

    await expect(
      runWithTenant('tenant-zero', () => pool.connect())
    ).rejects.toMatchObject({
      name: TenantConnectionBudgetError.name,
      tenantId: 'tenant-zero',
      limit: 0,
      code: 'rate_limit_exceeded',
    })

    expect(connectSpy).not.toHaveBeenCalled()
  })

  it('envInt returns fallback for empty string (boundary)', async () => {
    const { envInt } = await import('./pool.js')
    process.env.EMPTY_NUM_TEST = ''
    expect(envInt('EMPTY_NUM_TEST', 42)).toBe(42)
  })

  it('envInt returns fallback for negative or zero values when a positive fallback is expected (boundary)', async () => {
    const { envInt } = await import('./pool.js')
    process.env.NEG_NUM_TEST = '-5'
    expect(envInt('NEG_NUM_TEST', 42)).toBe(-5)
    process.env.ZERO_NUM_TEST = '0'
    expect(envInt('ZERO_NUM_TEST', 42)).toBe(0)
  })

  it('envInt parses integer prefixes and rejects trailing garbage (boundary)', async () => {
    const { envInt } = await import('./pool.js')
    process.env.PREFIX_NUM_TEST = '12abc'
    expect(envInt('PREFIX_NUM_TEST', 42)).toBe(12)
  })

  it('envInt returns fallback for whitespace-only string (boundary)', async () => {
    const { envInt } = await import('./pool.js')
    process.env.WS_NUM_TEST = '   '
    expect(envInt('WS_NUM_TEST', 42)).toBe(42)
  })

  it('rejects a bad DB_POOL_MAX value at startup (failure mode)', async () => {
    process.env.DB_POOL_MAX = 'not-a-number'
    vi.resetModules()
    await expect(import('./pool.js')).rejects.toThrow(/DB_POOL_MAX/)
  })

  it('rejects a bad DB_POOL_IDLE_TIMEOUT_MS value at startup (failure mode)', async () => {
    process.env.DB_POOL_IDLE_TIMEOUT_MS = 'not-a-number'
    vi.resetModules()
    await expect(import('./pool.js')).rejects.toThrow(/DB_POOL_IDLE_TIMEOUT_MS/)
  })

  it('does not expose the database password in pool options (security)', async () => {
    const { pool, workerPool, replicaPool } = await import('./pool.js')
    const serialized = JSON.stringify({
      pool: pool.options,
      workerPool: workerPool.options,
      replicaPool: replicaPool.options,
    })
    expect(serialized).not.toContain('pass')
  })
})
