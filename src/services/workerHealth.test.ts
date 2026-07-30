import { describe, it, expect, beforeEach } from 'vitest'
import { WorkerHealthService } from './workerHealth.js'

// ---------------------------------------------------------------------------
// In-memory Redis stub that supports scan, get, ttl, mGet, and multi
// ---------------------------------------------------------------------------
interface StoreEntry {
  value: string
  ttl: number // seconds remaining; -1 = no expiry, -2 = not found
}

function makeFakeRedis() {
  const store = new Map<string, StoreEntry>()

  return {
    _store: store,

    async set(key: string, value: string, ttlSeconds?: number) {
      store.set(key, {
        value,
        ttl: ttlSeconds ?? -1,
      })
    },

    async get(key: string): Promise<string | null> {
      const entry = store.get(key)
      if (!entry) return null
      return entry.value
    },

    async mGet(keys: string[]): Promise<(string | null)[]> {
      return keys.map((k) => {
        const entry = store.get(k)
        return entry ? entry.value : null
      })
    },

    multi() {
      const commands: Array<{ cmd: string; args: string[] }> = []
      return {
        ttl(key: string) {
          commands.push({ cmd: 'ttl', args: [key] })
          return this
        },
        async exec(): Promise<unknown[]> {
          return commands.map((c) => {
            if (c.cmd === 'ttl') {
              const entry = store.get(c.args[0])
              if (!entry) return -2
              return entry.ttl
            }
            return null
          })
        },
      }
    },

    async ttl(key: string): Promise<number> {
      const entry = store.get(key)
      if (!entry) return -2
      return entry.ttl
    },

    async scan(cursor: number, opts: { MATCH: string; COUNT: number }) {
      const pattern = opts.MATCH.replace('*', '.*')
      const re = new RegExp(`^${pattern}$`)
      const matching = Array.from(store.keys()).filter((k) => re.test(k))
      return { cursor: 0, keys: matching }
    },
  }
}

type FakeRedis = ReturnType<typeof makeFakeRedis>

describe('WorkerHealthService', () => {
  let redis: FakeRedis
  let service: WorkerHealthService

  beforeEach(() => {
    redis = makeFakeRedis()
    service = new WorkerHealthService(redis as any)
  })

  it('returns not-held for known workers when no keys exist in Redis', async () => {
    const result = await service.getWorkerStatuses()
    expect(result.workers).toHaveLength(1)
    expect(result.workers[0]).toMatchObject({
      name: 'score-snapshot',
      lockKey: 'cron:score-snapshot',
      held: false,
      pid: null,
      acquiredAt: null,
      ttlMs: -2,
    })
  })

  it('returns held=true for a key that exists with TTL', async () => {
    redis.set('cron:score-snapshot', '12345-1700000000000-abc', 30)

    const result = await service.getWorkerStatuses()
    const worker = result.workers.find((w) => w.lockKey === 'cron:score-snapshot')
    expect(worker).toBeDefined()
    expect(worker!.held).toBe(true)
    expect(worker!.pid).toBe(12345)
    expect(worker!.acquiredAt).toBe('2023-11-14T22:13:20.000Z')
    expect(worker!.ttlMs).toBe(30_000)
  })

  it('parses token correctly to extract pid and acquiredAt', async () => {
    redis.set('cron:score-snapshot', '99999-1715000000000-xyz789', 60)

    const result = await service.getWorkerStatuses()
    const worker = result.workers[0]
    expect(worker.pid).toBe(99999)
    expect(worker.acquiredAt).toBe('2024-05-06T12:53:20.000Z')
  })

  it('reports held=false for a key that exists but has ttl=0 (expired)', async () => {
    redis.set('cron:score-snapshot', '12345-1700000000000-abc', 0)

    const result = await service.getWorkerStatuses()
    const worker = result.workers.find((w) => w.lockKey === 'cron:score-snapshot')
    expect(worker).toBeDefined()
    expect(worker!.held).toBe(false)
    expect(worker!.ttlMs).toBe(0)
  })

  it('handles Redis scan failure gracefully', async () => {
    // Force scan to throw by overriding
    redis.scan = async () => {
      throw new Error('Redis down')
    }

    const result = await service.getWorkerStatuses()
    // Should still report known workers as not-held
    expect(result.workers).toHaveLength(1)
    expect(result.workers[0].held).toBe(false)
  })

  it('handles Redis mGet failure gracefully', async () => {
    redis.set('cron:score-snapshot', '12345-1700000000000-abc', 30)
    const originalMGet = redis.mGet
    redis.mGet = async () => {
      throw new Error('mGet failed')
    }

    const result = await service.getWorkerStatuses()
    const worker = result.workers.find((w) => w.lockKey === 'cron:score-snapshot')
    expect(worker).toBeDefined()
    expect(worker!.held).toBe(false)
    redis.mGet = originalMGet
  })
})
