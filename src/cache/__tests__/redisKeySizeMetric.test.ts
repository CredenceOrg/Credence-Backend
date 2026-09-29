import { describe, it, expect, vi, beforeEach } from 'vitest'

const recordRedisKeySize = vi.fn()

vi.mock('../../middleware/metrics.js', () => ({
  recordRedisKeySize,
}))

// Mocked so this test doesn't require a live Redis server — it only
// verifies that CacheService.set() reports the serialized payload size.
const fakeRedisClient = {
  set: vi.fn().mockResolvedValue('OK'),
  setEx: vi.fn().mockResolvedValue('OK'),
}

const fakeRedisConnection = {
  connect: vi.fn().mockResolvedValue(undefined),
  getClient: vi.fn(() => fakeRedisClient),
}

describe('CacheService redis_key_size_bytes instrumentation', () => {
  beforeEach(() => {
    recordRedisKeySize.mockClear()
    fakeRedisClient.set.mockClear()
    fakeRedisClient.setEx.mockClear()
  })

  it('records the serialized byte size of the value, labeled by namespace', async () => {
    const { CacheService } = await import('../redis.js')
    const cacheService = new CacheService(fakeRedisConnection as any)

    const value = { data: 'x'.repeat(100) }
    const expectedBytes = Buffer.byteLength(JSON.stringify(value), 'utf8')

    await cacheService.set('attestation', 'key-1', value, 300)

    expect(recordRedisKeySize).toHaveBeenCalledWith('attestation', expectedBytes)
  })

  it('records byte size for raw string values too', async () => {
    const { CacheService } = await import('../redis.js')
    const cacheService = new CacheService(fakeRedisConnection as any)

    await cacheService.set('bond', 'key-2', 'plain-string-value')

    expect(recordRedisKeySize).toHaveBeenCalledWith('bond', Buffer.byteLength('plain-string-value', 'utf8'))
  })

  it('a mega-key payload for one namespace does not affect the size recorded for another', async () => {
    const { CacheService } = await import('../redis.js')
    const cacheService = new CacheService(fakeRedisConnection as any)

    const megaValue = { blob: 'y'.repeat(5 * 1024 * 1024) } // 5MB+
    await cacheService.set('bulk_export', 'huge-key', megaValue, 60)
    await cacheService.set('trust', 'small-key', { score: 1 }, 60)

    expect(recordRedisKeySize).toHaveBeenCalledWith('bulk_export', Buffer.byteLength(JSON.stringify(megaValue), 'utf8'))
    expect(recordRedisKeySize).toHaveBeenCalledWith('trust', Buffer.byteLength(JSON.stringify({ score: 1 }), 'utf8'))
  })
})
