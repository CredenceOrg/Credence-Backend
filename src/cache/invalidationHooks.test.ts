import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invalidateCache: vi.fn(),
  createCacheKey: vi.fn((...parts: string[]) => parts.join(':')),
  metricInc: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('./invalidation.js', () => ({
  invalidateCache: mocks.invalidateCache,
  invalidateMultiple: vi.fn(),
  createCacheKey: mocks.createCacheKey,
}))

vi.mock('../utils/logger.js', () => ({
  logger: { debug: mocks.loggerDebug, error: mocks.loggerError },
}))

vi.mock('../middleware/metrics.js', () => ({ register: {} }))

vi.mock('prom-client', () => ({
  Counter: class {
    inc = mocks.metricInc
  },
}))

import {
  createCacheInvalidationHook,
  orgMembersListInvalidationHook,
  profileInvalidationHook,
} from './invalidationHooks.js'

describe('cache invalidation hook boundaries and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invalidateCache.mockResolvedValue(true)
  })

  it('returns a successful zero-key result for invalid and empty inputs', async () => {
    const invalidOrg = await orgMembersListInvalidationHook.execute(42)
    const emptyKeys = await createCacheInvalidationHook('empty', 'test', () => []).execute()

    expect(invalidOrg).toMatchObject({
      name: 'member.org_members_list.invalidate',
      keysAttempted: 0,
      keysInvalidated: 0,
    })
    expect(emptyKeys).toMatchObject({
      name: 'empty',
      keysAttempted: 0,
      keysInvalidated: 0,
    })
    expect(invalidOrg.error).toBeUndefined()
    expect(emptyKeys.error).toBeUndefined()
    expect(mocks.invalidateCache).not.toHaveBeenCalled()
  })

  it('attempts duplicate keys deterministically and counts successful invalidations', async () => {
    const hook = createCacheInvalidationHook('duplicate', 'test', () => ['same', 'same'])

    const result = await hook.execute()

    expect(mocks.invalidateCache).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ keysAttempted: 2, keysInvalidated: 2 })
    expect(result.error).toBeUndefined()
  })

  it('reports partial rejection without exposing cache keys or rejection details', async () => {
    mocks.invalidateCache
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('redis failure for private-cache-key'))
    const hook = createCacheInvalidationHook('partial', 'private-namespace', () => ['ok', 'secret'])

    const result = await hook.execute()

    expect(result).toMatchObject({
      name: 'partial',
      keysAttempted: 2,
      keysInvalidated: 1,
      error: '1 of 2 cache invalidations failed',
    })
    expect(mocks.metricInc).toHaveBeenCalledWith({ hook_name: 'partial', status: 'error' })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining('1 of 2 cache invalidations failed'),
    )
    expect(JSON.stringify(result)).not.toContain('private-cache-key')
    expect(mocks.loggerError.mock.calls.flat().join(' ')).not.toContain('private-cache-key')
  })

  it('recovers on a later execution after a transient invalidation rejection', async () => {
    mocks.invalidateCache
      .mockRejectedValueOnce(new Error('temporary redis error'))
      .mockResolvedValueOnce(true)
    const hook = createCacheInvalidationHook('retry', 'test', () => 'key')

    const failed = await hook.execute()
    const recovered = await hook.execute()

    expect(failed.error).toBe('1 of 1 cache invalidations failed')
    expect(failed.keysInvalidated).toBe(0)
    expect(recovered.error).toBeUndefined()
    expect(recovered.keysAttempted).toBe(1)
    expect(recovered.keysInvalidated).toBe(1)
    expect(mocks.metricInc).toHaveBeenNthCalledWith(1, { hook_name: 'retry', status: 'error' })
    expect(mocks.metricInc).toHaveBeenNthCalledWith(2, { hook_name: 'retry', status: 'success' })
  })

  it('keeps concurrent executions independent and aggregates a composite partial failure', async () => {
    mocks.invalidateCache.mockImplementation(async (_namespace: string, key: string) => {
      if (key === 'org:org-1:members') throw new Error('private key failure')
      return true
    })
    const concurrentHook = createCacheInvalidationHook(
      'concurrent',
      'test',
      (...args) => String(args[0]),
    )

    const [first, second] = await Promise.all([
      concurrentHook.execute('first'),
      concurrentHook.execute('second'),
    ])
    const composite = await profileInvalidationHook.execute('org-1', 'member-1')

    expect(first.keysAttempted).toBe(1)
    expect(second.keysAttempted).toBe(1)
    expect(first.keysInvalidated).toBe(1)
    expect(second.keysInvalidated).toBe(1)
    expect(composite).toMatchObject({
      name: 'profile.invalidate',
      keysAttempted: 2,
      keysInvalidated: 1,
      error: '1 of 1 cache invalidations failed',
    })
  })
})