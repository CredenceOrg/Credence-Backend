import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invalidateCache } from './invalidation.js'
import { cache } from './redis.js'
import { recordStaleCacheRead } from '../middleware/metrics.js'

vi.mock('./redis.js', () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    clearNamespace: vi.fn()
  }
}))

vi.mock('../middleware/metrics.js', () => ({
  recordStaleCacheRead: vi.fn()
}))

vi.mock('./invalidationBus.js', () => ({
  getInvalidationBus: () => ({
    publish: vi.fn().mockResolvedValue(undefined)
  })
}))

describe('stable cache stale detection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
