import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  invalidateCache,
  invalidateMultiple,
  invalidatePattern,
  invalidateTenantCache,
  isValidTenantId
} from './invalidation.js'
import { cache } from './redis.js'
import { recordStaleCacheRead } from '../middleware/metrics.js'
import { getInvalidationBus } from './invalidationBus.js'
import { transactionContextStorage, runPostCommit, runRollback } from '../db/transaction.js'
import { ValidationError, ServiceUnavailableError } from '../lib/errors.js'

vi.mock('./redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearNamespace: vi.fn(),
    healthCheck: vi.fn()
  }
}))

vi.mock('../middleware/metrics.js', () => ({
  recordStaleCacheRead: vi.fn()
}))

const mockPublish = vi.fn().mockResolvedValue(undefined)
vi.mock('./invalidationBus.js', () => ({
  getInvalidationBus: vi.fn(() => ({
    publish: mockPublish
  }))
}))

vi.mock('../db/transaction.js', () => ({
  transactionContextStorage: {
    getStore: vi.fn()
  },
  runPostCommit: vi.fn(),
  runRollback: vi.fn()
}))

describe('stable cache stale detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transactionContextStorage.getStore).mockReset()
  })

  it('treats reordered object keys as equivalent', async () => {
    vi.mocked(cache.delete).mockResolvedValue(true)
    vi.mocked(cache.get).mockResolvedValue({ b: 2, a: 1 })

    await invalidateCache('test', 'reordered', { a: 1, b: 2 }, { verify: true })

    expect(recordStaleCacheRead).not.toHaveBeenCalled()
  })

  it('handles BigInt and Date values without false positives', async () => {
    vi.mocked(cache.delete).mockResolvedValue(true)
    vi.mocked(cache.get).mockResolvedValue({
      id: 10n,
      updatedAt: new Date('2024-01-01T00:00:00.000Z')
    })

    await invalidateCache(
      'test',
      'typed',
      {
        id: 10n,
        updatedAt: new Date('2024-01-01T00:00:00.000Z')
      },
      { verify: true }
    )

    expect(recordStaleCacheRead).not.toHaveBeenCalled()
  })

  it('preserves differences for undefined values versus missing keys', async () => {
    vi.mocked(cache.delete).mockResolvedValue(true)
    vi.mocked(cache.get).mockResolvedValue({ present: undefined })

    await invalidateCache('test', 'undefined', {}, { verify: true })

    expect(recordStaleCacheRead).toHaveBeenCalledWith('test')
  })

  it('still reports genuine divergence when the payload changes', async () => {
    vi.mocked(cache.delete).mockResolvedValue(true)
    vi.mocked(cache.get).mockResolvedValue({ status: 'pending' })

    await invalidateCache('test', 'changed', { status: 'completed' }, { verify: true })

    expect(recordStaleCacheRead).toHaveBeenCalledWith('test')
  })
})

describe('invalidateCache boundaries and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transactionContextStorage.getStore).mockReset()
  })

  it('handles cache delete failure gracefully and still publishes event', async () => {
    vi.mocked(cache.delete).mockResolvedValue(false) // cache delete fails
    const result = await invalidateCache('ns', 'key1')
    
    expect(result).toBe(false)
    expect(mockPublish).toHaveBeenCalledWith({
      type: 'invalidate',
      namespace: 'ns',
      key: 'key1'
    })
  })

  it('defers invalidation to runPostCommit when in transaction context', async () => {
    vi.mocked(transactionContextStorage.getStore).mockReturnValue({ id: 'tx-1' })
    vi.mocked(cache.delete).mockResolvedValue(true)
    
    const result = await invalidateCache('ns', 'key1')
    
    expect(result).toBe(true)
    // delete and publish should not be called immediately
    expect(cache.delete).not.toHaveBeenCalled()
    expect(mockPublish).not.toHaveBeenCalled()
    
    // verify runPostCommit was scheduled
    expect(runPostCommit).toHaveBeenCalled()
    
    // execute the deferred commit callback
    const commitCb = vi.mocked(runPostCommit).mock.calls[0][0]
    await commitCb()
    
    expect(cache.delete).toHaveBeenCalledWith('ns', 'key1')
    expect(mockPublish).toHaveBeenCalled()
  })
})

describe('invalidateMultiple boundaries and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transactionContextStorage.getStore).mockReset()
  })

  it('handles partial failures by publishing event and returning correct count', async () => {
    // first succeeds, second fails
    vi.mocked(cache.delete).mockImplementation(async (ns, key) => key === 'key1')
    
    const result = await invalidateMultiple('ns', ['key1', 'key2'])
    
    expect(result).toBe(1) // only 1 successful delete
    expect(mockPublish).toHaveBeenCalledWith({
      type: 'invalidate_multiple',
      namespace: 'ns',
      keys: ['key1', 'key2']
    })
  })
})

describe('invalidatePattern boundaries and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transactionContextStorage.getStore).mockReset()
  })

  it('defers pattern invalidation during active transaction', async () => {
    vi.mocked(transactionContextStorage.getStore).mockReturnValue({ id: 'tx-1' })
    vi.mocked(cache.clearNamespace).mockResolvedValue(5)
    
    const result = await invalidatePattern('ns', 'pattern:*')
    expect(result).toBe(0) // immediately returns 0 for deferred
    expect(cache.clearNamespace).not.toHaveBeenCalled()
    expect(runPostCommit).toHaveBeenCalled()
    
    const commitCb = vi.mocked(runPostCommit).mock.calls[0][0]
    await commitCb()
    
    expect(cache.clearNamespace).toHaveBeenCalledWith('ns:pattern:*')
    expect(mockPublish).toHaveBeenCalled()
  })
})

describe('invalidateTenantCache permission, validation and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(transactionContextStorage.getStore).mockReset()
  })

  it('returns valid state and clears tenant cache on success', async () => {
    const validTenantId = '12345678-1234-1234-1234-123456789012'
    vi.mocked(cache.healthCheck).mockResolvedValue({ healthy: true })
    vi.mocked(cache.clearNamespace).mockResolvedValue(42)

    const result = await invalidateTenantCache(validTenantId)
    
    expect(result).toEqual({ tenantId: validTenantId, keysCleared: 42 })
    expect(cache.clearNamespace).toHaveBeenCalledWith(validTenantId)
  })

  it('throws ValidationError when tenantId is not a valid UUID', async () => {
    const invalidTenantId = 'not-a-uuid'
    
    await expect(invalidateTenantCache(invalidTenantId)).rejects.toThrow(ValidationError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })

  it('throws ServiceUnavailableError when cache backend is down', async () => {
    const validTenantId = '12345678-1234-1234-1234-123456789012'
    vi.mocked(cache.healthCheck).mockResolvedValue({ healthy: false })

    await expect(invalidateTenantCache(validTenantId)).rejects.toThrow(ServiceUnavailableError)
    expect(cache.clearNamespace).not.toHaveBeenCalled()
  })
})
