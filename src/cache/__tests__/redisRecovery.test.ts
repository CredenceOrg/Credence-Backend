import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { CacheService, RedisConnection } from '../redis.js'

const mocks = vi.hoisted(() => ({
  client: {
    isOpen: false,
    connect: vi.fn(), on: vi.fn(), ping: vi.fn(), quit: vi.fn(), disconnect: vi.fn(),
    get: vi.fn(), set: vi.fn(), setEx: vi.fn(), del: vi.fn(), keys: vi.fn(),
    exists: vi.fn(), expire: vi.fn(), ttl: vi.fn(),
  },
  error: vi.fn(), info: vi.fn(), warn: vi.fn(), hit: vi.fn(), miss: vi.fn(),
  size: vi.fn(), timeout: vi.fn(), success: vi.fn(),
}))

vi.mock('redis', () => ({ createClient: vi.fn(() => mocks.client) }))
// Keep the real LRU implementation, injecting its supported clock so TTL tests
// do not depend on the module's captured monotonic system clock.
vi.mock('lru-cache', async (importOriginal) => {
  const { LRUCache } = await importOriginal<typeof import('lru-cache')>()
  return { LRUCache: class extends LRUCache<string, object> {
    constructor(options: ConstructorParameters<typeof LRUCache<string, object>>[0]) {
      super({ ...options, perf: { now: () => Date.now() }, ttlResolution: 0 })
    }
  } }
})
vi.mock('../../utils/logger.js', () => ({ logger: { error: mocks.error, info: mocks.info, warn: mocks.warn } }))
vi.mock('../../middleware/metrics.js', () => ({ recordRedisKeySize: mocks.size }))
vi.mock('../../utils/cacheContext.js', () => ({
  recordCacheHit: mocks.hit, recordCacheMiss: mocks.miss,
  isObjectStale: (value: { stale?: boolean } | null) => value?.stale === true,
}))
vi.mock('../../observability/timeoutMetrics.js', () => ({
  createDefaultMetricsCollector: () => ({ onTimeout: mocks.timeout, onSuccess: mocks.success }),
  createTimeoutEvent: (event: unknown) => event,
  createSuccessEvent: (event: unknown) => event,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

let cache: CacheService
let connection: RedisConnection

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  vi.clearAllMocks()
  mocks.client.isOpen = false
  for (const value of Object.values(mocks.client)) {
    if (typeof value === 'function') value.mockReset()
  }
  mocks.client.connect.mockImplementation(async () => { mocks.client.isOpen = true })
  mocks.client.on.mockReturnValue(mocks.client)
  mocks.client.get.mockResolvedValue(null)
  mocks.client.set.mockResolvedValue('OK')
  mocks.client.setEx.mockResolvedValue('OK')
  mocks.client.del.mockResolvedValue(1)
  mocks.client.keys.mockResolvedValue([])
  mocks.client.exists.mockResolvedValue(0)
  mocks.client.expire.mockResolvedValue(1)
  mocks.client.ttl.mockResolvedValue(-2)
  mocks.client.ping.mockResolvedValue('PONG')
  mocks.client.quit.mockImplementation(async () => { mocks.client.isOpen = false })
  mocks.client.disconnect.mockImplementation(async () => { mocks.client.isOpen = false })
  const module = await import('../redis.js')
  cache = new module.CacheService(module.redisConnection)
  connection = module.redisConnection
})

afterEach(() => vi.useRealTimers())

describe('Redis connection recovery', () => {
  it('records lifecycle events without including connection details', () => {
    mocks.client.on.mock.calls.find(([event]) => event === 'connect')![1]()
    mocks.client.on.mock.calls.find(([event]) => event === 'disconnect')![1]()
    expect(mocks.info).toHaveBeenCalledWith('Redis client connected')
    expect(mocks.warn).toHaveBeenCalledWith('Redis client disconnected')
  })
  it('waits for the shared connection even when the socket is already open', async () => {
    const opened = deferred<void>()
    mocks.client.connect.mockImplementationOnce(() => {
      mocks.client.isOpen = true
      return opened.promise
    })
    const finished = vi.fn()
    const first = connection.connect()
    const second = connection.connect().then(finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    expect(mocks.client.connect).toHaveBeenCalledTimes(1)
    opened.resolve()
    await Promise.all([first, second])
    expect(finished).toHaveBeenCalledTimes(1)
    await connection.connect()
    expect(mocks.client.connect).toHaveBeenCalledTimes(1)
  })

  it('shares a failed attempt and clears it so a retry can succeed', async () => {
    const attempt = deferred<void>()
    const error = new Error('Connection refused')
    mocks.client.connect.mockReturnValueOnce(attempt.promise)
    const callers = Promise.allSettled([connection.connect(), connection.connect()])
    attempt.reject(error)
    const results = await callers
    expect(results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }])
    await connection.connect()
    expect(mocks.client.connect).toHaveBeenCalledTimes(2)
  })

  it('recovers from a synchronous connect failure', async () => {
    mocks.client.connect.mockImplementationOnce(() => { throw new Error('Invalid connection') })
    await expect(connection.connect()).rejects.toThrow('Invalid connection')
    await expect(connection.connect()).resolves.toBeUndefined()
  })

  it('reports closed, ready, and failed-ping health without leaking connection credentials', async () => {
    expect(await connection.isHealthy()).toBe(false)
    expect(mocks.client.ping).not.toHaveBeenCalled()
    await connection.connect()
    expect(await cache.healthCheck()).toEqual({ healthy: true })
    mocks.client.ping.mockRejectedValueOnce(new Error('redis://user:private-password@host'))
    expect(await cache.healthCheck()).toEqual({ healthy: false })
    const handler = mocks.client.on.mock.calls.find(([event]) => event === 'error')![1]
    handler(new Error('redis://user:private-password@host'))
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private-password')
  })

  it.each(['disconnect', 'forceClose'] as const)('makes %s idempotent and permits reconnect', async (method) => {
    await connection.connect()
    await connection[method]()
    await connection[method]()
    expect(method === 'disconnect' ? mocks.client.quit : mocks.client.disconnect).toHaveBeenCalledTimes(1)
    await connection.connect()
    expect(mocks.client.connect).toHaveBeenCalledTimes(2)
  })
})

describe('cache boundaries and diagnostics', () => {
  it('queries Redis TTL even for a local persistent entry', async () => {
    await cache.set('test', 'key', 'persistent')
    mocks.client.ttl.mockResolvedValueOnce(-1)
    expect(await cache.ttl('test', 'key')).toBe(-1)
    expect(mocks.client.ttl).toHaveBeenCalledWith('test:key')
  })

  it('clears a namespace without evicting another namespace', async () => {
    await cache.set('test', 'key', 'first')
    await cache.set('other', 'key', 'second')
    mocks.client.keys.mockResolvedValueOnce(['test:key'])
    expect(await cache.clearNamespace('test')).toBe(1)
    expect(mocks.client.del).toHaveBeenCalledWith(['test:key'])
    expect(await cache.get('test', 'key')).toBeNull()
    expect(await cache.get('other', 'key')).toBe('second')
  })

  it('recognizes L1 existence and Redis presence without mistaking nonexistence for success', async () => {
    await cache.set('test', 'key', 'cached')
    expect(await cache.exists('test', 'key')).toBe(true)
    expect(mocks.client.exists).not.toHaveBeenCalled()
    mocks.client.exists.mockResolvedValueOnce(1)
    expect(await cache.exists('test', 'remote')).toBe(true)
    expect(await cache.exists('test', 'missing')).toBe(false)
    mocks.client.del.mockResolvedValueOnce(0)
    expect(await cache.delete('test', 'missing')).toBe(false)
    mocks.client.expire.mockResolvedValueOnce(0)
    expect(await cache.expire('test', 'missing', 60)).toBe(false)
  })

  it.each([new Error('Health unavailable'), 'unexpected'])('preserves the health-check failure envelope for %s', async (error) => {
    vi.spyOn(connection, 'isHealthy').mockRejectedValueOnce(error)
    expect(await cache.healthCheck()).toEqual({ healthy: false, error: error instanceof Error ? error.message : 'Unknown error' })
  })
  it.each([false, 0, '', { stale: true }, ['value']])('preserves valid falsy/structured data %j and the L1 hit metric', async (value) => {
    expect(await cache.set('test', 'key', value, 1)).toBe(true)
    expect(await cache.get('test', 'key')).toEqual(value)
    expect(mocks.client.get).not.toHaveBeenCalled()
    expect(mocks.hit).toHaveBeenCalledWith(typeof value === 'object' && !Array.isArray(value) && value.stale === true)
  })

  it.each(['{"value":1}', 'plain-text', 'null'])('parses or falls back for Redis response %s', async (response) => {
    mocks.client.get.mockResolvedValueOnce(response)
    const expected = response === 'plain-text' ? response : JSON.parse(response)
    expect(await cache.get('test', 'key')).toEqual(expected)
    expect(await cache.get('test', 'key')).toEqual(expected)
    expect(mocks.client.get).toHaveBeenCalledTimes(1)
    if (expected === null) expect(mocks.miss).toHaveBeenCalledTimes(2)
  })

  it('does not negative-cache a Redis miss and reads a subsequently created value', async () => {
    expect(await cache.get('test', 'key')).toBeNull()
    mocks.client.get.mockResolvedValueOnce('created')
    expect(await cache.get('test', 'key')).toBe('created')
    expect(mocks.client.get).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid SET TTL %s without a write', async (ttl) => {
    await expect(cache.set('test', 'key', 'value', ttl)).resolves.toBe(false)
    expect(mocks.client.set).not.toHaveBeenCalled()
    expect(mocks.client.setEx).not.toHaveBeenCalled()
  })

  it.each([undefined, () => {}, Symbol('value')])('returns false for non-serializable input %s', async (value) => {
    await expect(cache.set('test', 'key', value)).resolves.toBe(false)
    expect(mocks.size).not.toHaveBeenCalled()
    expect(mocks.client.set).not.toHaveBeenCalled()
  })

  it('handles circular input without replacing a previously valid cached value', async () => {
    await cache.set('test', 'key', 'original')
    const circular: { self?: unknown } = {}
    circular.self = circular
    await expect(cache.set('test', 'key', circular)).resolves.toBe(false)
    mocks.client.get.mockResolvedValueOnce('original')
    expect(await cache.get('test', 'key')).toBe('original')
  })

  it('invalidates an unacknowledged overwrite and retries without exposing keys/payload/error contents', async () => {
    await cache.set('test', 'private-key', 'original')
    mocks.client.set.mockRejectedValueOnce(new Error('NOPERM private-payload private-password'))
    expect(await cache.set('test', 'private-key', 'private-payload')).toBe(false)
    mocks.client.get.mockResolvedValueOnce('remote-authoritative')
    expect(await cache.get('test', 'private-key')).toBe('remote-authoritative')
    expect(JSON.stringify(mocks.error.mock.calls)).not.toMatch(/private-key|private-payload|private-password/)
    expect(JSON.stringify(mocks.success.mock.calls)).not.toContain('private-key')
    expect(await cache.set('test', 'private-key', 'recovered')).toBe(true)
    expect(await cache.get('test', 'private-key')).toBe('recovered')
  })

  it('expires a local write rather than serving it past its TTL', async () => {
    await cache.set('test', 'key', 'old', 1)
    await vi.advanceTimersByTimeAsync(1001)
    mocks.client.get.mockResolvedValueOnce('new')
    expect(await cache.get('test', 'key')).toBe('new')
    expect(mocks.client.get).toHaveBeenCalledTimes(1)
  })

  it('does not extend L1 when Redis rejects EXPIRE', async () => {
    await cache.set('test', 'key', 'old', 1)
    mocks.client.expire.mockRejectedValueOnce(new Error('NOPERM sensitive-details'))
    expect(await cache.expire('test', 'key', 100)).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    expect(await cache.get('test', 'key')).toBeNull()
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('sensitive-details')
  })

  it.each([0, -1])('honors EXPIRE %i immediate deletion in L1', async (ttl) => {
    await cache.set('test', 'key', 'old')
    expect(await cache.expire('test', 'key', ttl)).toBe(true)
    expect(await cache.get('test', 'key')).toBeNull()
    expect(mocks.client.expire).toHaveBeenCalledWith('test:key', ttl)
  })

  it.each([NaN, Infinity, 1.5])('rejects non-integer EXPIRE %s', async (ttl) => {
    expect(await cache.expire('test', 'key', ttl)).toBe(false)
    expect(mocks.client.expire).not.toHaveBeenCalled()
  })

  it('uses Redis sentinel TTLs and preserves operation-specific failure fallbacks', async () => {
    mocks.client.ttl.mockResolvedValueOnce(-1).mockResolvedValueOnce(-2)
    expect(await cache.ttl('test', 'key')).toBe(-1)
    expect(await cache.ttl('test', 'key')).toBe(-2)
    mocks.client.ttl.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await cache.ttl('test', 'key')).toBe(-2)
    mocks.client.exists.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await cache.exists('test', 'key')).toBe(false)
    mocks.client.del.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await cache.delete('test', 'key')).toBe(false)
    mocks.client.keys.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await cache.clearNamespace('test')).toBe(0)
  })
})

describe('mutation fences and origin recovery', () => {
  it('uses a cached value without calling origin, and reports a rejected background set safely', async () => {
    await cache.set('test', 'cached', 'value')
    const origin = vi.fn(async () => 'fresh')
    expect(await cache.getOrFetch('test', 'cached', origin, 60)).toBe('value')
    expect(origin).not.toHaveBeenCalled()
    vi.spyOn(cache, 'set').mockRejectedValueOnce(new Error('private-payload'))
    expect(await cache.getOrFetch('test', 'missing', origin, 60)).toBe('fresh')
    await Promise.resolve()
    expect(mocks.error).toHaveBeenCalledWith('getOrFetch: failed to cache value')
    expect(JSON.stringify(mocks.error.mock.calls)).not.toContain('private-payload')
  })
  it.each(['delete', 'clearNamespace', 'clearL1Pattern'] as const)('does not refill L1 from a delayed read after %s', async (method) => {
    const read = deferred<string>()
    const started = deferred<void>()
    mocks.client.get.mockImplementationOnce(() => { started.resolve(); return read.promise })
    const pending = cache.get('test', 'key')
    await started.promise
    if (method === 'clearL1Pattern') cache.clearL1Pattern('test:*')
    else if (method === 'clearNamespace') await cache.clearNamespace('test')
    else await cache.delete('test', 'key')
    read.resolve('old')
    expect(await pending).toBe('old') // the already-started caller may finish
    expect(await cache.get('test', 'key')).toBeNull() // later readers must not see its stale fill
  })

  it('does not let a delayed SET acknowledgment resurrect a deleted L1 value', async () => {
    const write = deferred<string>()
    const started = deferred<void>()
    mocks.client.set.mockImplementationOnce(() => { started.resolve(); return write.promise })
    const pending = cache.set('test', 'key', 'old')
    await started.promise
    await cache.delete('test', 'key')
    write.resolve('OK')
    expect(await pending).toBe(true)
    expect(await cache.get('test', 'key')).toBeNull()
  })

  it('conservatively refetches Redis after overlapping writes complete out of order', async () => {
    const earlier = deferred<string>()
    const started = deferred<void>()
    mocks.client.set.mockImplementationOnce(() => { started.resolve(); return earlier.promise })
    const pending = cache.set('test', 'key', 'first')
    await started.promise
    await cache.set('test', 'key', 'second')
    earlier.resolve('OK')
    await pending
    mocks.client.get.mockResolvedValueOnce('authoritative')
    expect(await cache.get('test', 'key')).toBe('authoritative')
    expect(mocks.client.get).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent origin calls, propagates a shared rejection, and recovers on retry', async () => {
    const origin = deferred<string>()
    const started = deferred<void>()
    const fetch = vi.fn(() => { started.resolve(); return origin.promise })
    const results = Promise.allSettled([
      cache.getOrFetch('test', 'key', fetch, 60), cache.getOrFetch('test', 'key', fetch, 60),
    ])
    await started.promise
    await Promise.resolve()
    const error = new Error('Origin unavailable')
    origin.reject(error)
    expect(await results).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await cache.getOrFetch('test', 'key', async () => 'recovered', 60)).toBe('recovered')
  })

  it('returns fresh origin data even if its cache write fails', async () => {
    mocks.client.setEx.mockRejectedValueOnce(new Error('Permission denied'))
    expect(await cache.getOrFetch('test', 'key', async () => 'fresh', 60)).toBe('fresh')
    await Promise.resolve()
    expect(mocks.error).toHaveBeenCalledWith('Cache set failed')
  })

  it('times out an unavailable Redis read and can retry successfully', async () => {
    const late = deferred<string>()
    mocks.client.get.mockReturnValueOnce(late.promise)
    const assertion = expect(cache.get('test', 'key')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(501)
    await assertion
    expect(mocks.error).toHaveBeenCalledWith('Cache get failed')
    expect(mocks.miss).toHaveBeenCalledTimes(1)
    late.resolve('stale-after-timeout')
    await Promise.resolve()
    await Promise.resolve()
    mocks.client.get.mockResolvedValueOnce('recovered')
    expect(await cache.get('test', 'key')).toBe('recovered')
  })
})
