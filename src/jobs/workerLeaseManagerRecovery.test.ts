import { EventEmitter } from 'node:events'
import type { Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { OUTBOX_LEADER_LOCK_KEY, WorkerLeaseManager } from './workerLeaseManager.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// Session-level locks survive a normal pool release and are reentrant.
// A blocking acquisition returns void; only pg_try_advisory_lock returns
// a boolean. Model those contracts so mocks cannot hide the original bug.
type ModelQueryResult = { rows: Array<Record<string, unknown>> }
type ModelClient = EventEmitter & {
  id: number
  query: Mock<(sql: string, parameters?: number[]) => Promise<ModelQueryResult>>
  release: Mock<(destroy?: boolean) => void>
}

function databaseDouble() {
  const locks = new Map<number, { owner: number; count: number }>()
  let nextId = 0
  const clients: ModelClient[] = []
  function createClient(): ModelClient {
    const id = ++nextId
    const emitter = new EventEmitter()
    const client = Object.assign(emitter, {
      id,
      query: vi.fn(async (sql: string, parameters?: number[]): Promise<ModelQueryResult> => {
        const key = parameters?.[0] ?? OUTBOX_LEADER_LOCK_KEY
        if (sql.includes('pg_try_advisory_lock')) {
          const held = locks.get(key)
          const acquired = !held || held.owner === id
          if (acquired) locks.set(key, { owner: id, count: (held?.count ?? 0) + 1 })
          return { rows: [{ acquired }] }
        }
        if (sql.includes('pg_advisory_lock')) {
          locks.set(key, { owner: id, count: (locks.get(key)?.count ?? 0) + 1 })
          return { rows: [{ pg_advisory_lock: '' }] }
        }
        if (sql.includes('pg_advisory_unlock')) {
          const held = locks.get(key)
          const unlocked = held?.owner === id
          if (unlocked && held) {
            if (held.count === 1) locks.delete(key)
            else held.count--
          }
          return { rows: [{ unlocked }] }
        }
        return { rows: [] }
      }),
      release: vi.fn((destroy?: boolean) => {
        if (destroy) {
          for (const [key, held] of locks) if (held.owner === id) locks.delete(key)
        }
      }),
    })
    clients.push(client)
    return client
  }
  const pool = { connect: vi.fn(async () => createClient()) }
  return { pool, clients, locks, createClient }
}

describe('worker lease boundaries and recovery', () => {
  const managers: WorkerLeaseManager[] = []
  function manager(db: ReturnType<typeof databaseDouble>, options: Partial<ConstructorParameters<typeof WorkerLeaseManager>[0]> = {}) {
    const instance = new WorkerLeaseManager({ pool: db.pool as unknown as Pool, retryIntervalMs: 100, heartbeatIntervalMs: 200, log: vi.fn(), ...options })
    managers.push(instance)
    return instance
  }

  beforeEach(() => vi.useFakeTimers())
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(instance => instance.stop()))
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each(['retryIntervalMs', 'heartbeatIntervalMs'] as const)('validates %s timer bounds', name => {
    for (const value of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
      expect(() => manager(databaseDouble(), { [name]: value })).toThrow(new RegExp(name))
    }
  })

  it.each([NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects an unsafe lock key %s', lockKey => {
    expect(() => manager(databaseDouble(), { lockKey })).toThrow(/lockKey/)
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER])('uses a valid lock key %s as a query parameter', async lockKey => {
    const db = databaseDouble()
    const instance = manager(db, { lockKey })
    await instance.start()
    expect(instance.currentState).toBe('leader')
    expect(db.clients[0].query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS acquired', [lockKey])
    await instance.stop()
    expect(db.locks.size).toBe(0)
  })

  it('uses nonblocking acquisition and never accumulates reentrant locks', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    expect(instance.currentState).toBe('leader')
    await instance.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(db.locks.get(OUTBOX_LEADER_LOCK_KEY)?.count).toBe(1)
    await instance.stop()
    expect(db.locks.size).toBe(0)
    expect(db.clients[0].release).toHaveBeenCalledTimes(1)
  })

  it('keeps the loser in standby, returns its client, and hands leadership off after release', async () => {
    const db = databaseDouble()
    const first = manager(db)
    const second = manager(db)
    await first.start()
    await second.start()
    expect(first.currentState).toBe('leader')
    expect(second.currentState).toBe('standby')
    expect(db.clients[1].release).toHaveBeenCalledTimes(1)
    expect(db.clients[1].release).toHaveBeenCalledWith()
    await vi.advanceTimersByTimeAsync(99)
    expect(db.pool.connect).toHaveBeenCalledTimes(2)
    await first.stop()
    await vi.advanceTimersByTimeAsync(1)
    expect(second.currentState).toBe('leader')
    expect(db.locks.size).toBe(1)
  })

  it('does not promote a delayed connection after stop and returns it exactly once', async () => {
    const db = databaseDouble()
    const connected = deferred<ReturnType<typeof db.createClient>>()
    db.pool.connect.mockReturnValueOnce(connected.promise)
    const instance = manager(db)
    const start = instance.start()
    await instance.stop()
    const client = db.createClient()
    connected.resolve(client)
    await start
    expect(instance.currentState).toBe('standby')
    expect(client.query).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fences a delayed acquisition after stop and destroys its uncertain session', async () => {
    const db = databaseDouble()
    const client = db.createClient()
    const acquired = deferred<{ rows: Array<{ acquired: boolean }> }>()
    client.query.mockReturnValueOnce(acquired.promise)
    db.pool.connect.mockResolvedValueOnce(client)
    const onAcquired = vi.fn()
    const instance = manager(db)
    instance.on({ onAcquired })
    const start = instance.start()
    await vi.advanceTimersByTimeAsync(0)
    await instance.stop()
    acquired.resolve({ rows: [{ acquired: true }] })
    await start
    expect(instance.currentState).toBe('standby')
    expect(onAcquired).not.toHaveBeenCalled()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates a prior pending connection from a restarted run', async () => {
    const db = databaseDouble()
    const oldConnection = deferred<ReturnType<typeof db.createClient>>()
    db.pool.connect.mockReturnValueOnce(oldConnection.promise)
    const instance = manager(db)
    const oldStart = instance.start()
    await instance.stop()
    await instance.start()
    const leaderClient = db.clients[0]
    const oldClient = db.createClient()
    oldConnection.resolve(oldClient)
    await oldStart
    expect(instance.currentState).toBe('leader')
    expect(leaderClient.release).not.toHaveBeenCalled()
    expect(oldClient.query).not.toHaveBeenCalled()
    expect(oldClient.release).toHaveBeenCalledTimes(1)
    await instance.stop()
    expect(db.locks.size).toBe(0)
  })

  it('does not run overlapping heartbeat queries', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    const heartbeat = deferred<{ rows: never[] }>()
    const client = db.clients[0]
    client.query.mockReturnValueOnce(heartbeat.promise)
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.query.mock.calls.filter(([sql]) => sql === 'SELECT 1')).toHaveLength(1)
    heartbeat.resolve({ rows: [] })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not let an old heartbeat failure demote or release a new leader', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    const onReleased = vi.fn()
    instance.on({ onReleased })
    await instance.start()
    const heartbeat = deferred<{ rows: never[] }>()
    const oldClient = db.clients[0]
    oldClient.query.mockReturnValueOnce(heartbeat.promise)
    await vi.advanceTimersByTimeAsync(200)
    await instance.stop()
    await instance.start()
    const newClient = db.clients[1]
    heartbeat.reject(new Error('late transport failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.currentState).toBe('leader')
    expect(newClient.release).not.toHaveBeenCalled()
    expect(oldClient.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(onReleased).toHaveBeenCalledTimes(1)
  })

  it.each(['connect', 'acquire', 'heartbeat'] as const)('recovers from %s permission/transport failure with safe diagnostics', async phase => {
    const db = databaseDouble()
    const log = vi.fn()
    const onError = vi.fn()
    const error = new Error('permission denied: postgres://user:secret@private-host')
    const client = db.createClient()
    if (phase === 'connect') db.pool.connect.mockRejectedValueOnce(error)
    else db.pool.connect.mockResolvedValueOnce(client)
    if (phase === 'acquire') client.query.mockRejectedValueOnce(error)
    const instance = manager(db, { log })
    instance.on({ onError })
    await instance.start()
    if (phase === 'heartbeat') {
      client.query.mockRejectedValueOnce(error)
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(instance.currentState).toBe('standby')
    expect(onError).toHaveBeenCalledWith(error)
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
    if (phase !== 'connect') expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    await vi.advanceTimersByTimeAsync(99)
    expect(instance.currentState).toBe('standby')
    await vi.advanceTimersByTimeAsync(1)
    expect(instance.currentState).toBe('leader')
    expect(db.locks.size).toBe(1)
  })

  it.each([{ rows: [] }, { rows: [{ acquired: 'true' }] }, { rows: [{ acquired: null }] }])('rejects malformed acquisition result %j and destroys the session', async ({ rows }) => {
    const db = databaseDouble()
    const client = db.createClient()
    client.query.mockResolvedValueOnce({ rows } as never)
    db.pool.connect.mockResolvedValueOnce(client)
    const instance = manager(db)
    await instance.start()
    expect(instance.currentState).toBe('standby')
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(instance.currentState).toBe('leader')
  })

  it('destroys a session if unlock is rejected instead of pooling a held lock', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    const client = db.clients[0]
    client.query.mockRejectedValueOnce(new Error('unlock denied'))
    await instance.stop()
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(db.locks.size).toBe(0)
    expect(instance.currentState).toBe('standby')
  })

  it('contains client error events and retries with a fresh session', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    const onReleased = vi.fn()
    instance.on({ onReleased })
    await instance.start()
    const client = db.clients[0]
    expect(client.listenerCount('error')).toBe(1)
    client.emit('error', new Error('backend disconnected'))
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.currentState).toBe('standby')
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(client.listenerCount('error')).toBe(0)
    expect(onReleased).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(instance.currentState).toBe('leader')
  })

  it.each(['onStateChange', 'onAcquired', 'onReleased', 'onError'] as const)('contains throwing %s observers without leaking sessions', async event => {
    const db = databaseDouble()
    const instance = manager(db)
    instance.on({ [event]: () => { throw new Error('observer credentials') } })
    if (event === 'onError') db.pool.connect.mockRejectedValueOnce(new Error('connect failed'))
    await instance.start()
    if (event === 'onError') await vi.advanceTimersByTimeAsync(100)
    expect(instance.currentState).toBe('leader')
    await instance.stop()
    expect(instance.currentState).toBe('standby')
    expect(db.locks.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(db.clients.every(client => client.release.mock.calls.length === 1)).toBe(true)
  })

  it('contains rejected async observers and logger exceptions', async () => {
    const db = databaseDouble()
    const instance = manager(db, { log: () => { throw new Error('logger failed') } })
    instance.on({ onAcquired: async () => { throw new Error('async observer failed') } })
    await instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.currentState).toBe('leader')
    await instance.stop()
    expect(db.locks.size).toBe(0)
  })

  it('shares concurrent starts without allocating duplicate clients', async () => {
    const db = databaseDouble()
    const connection = deferred<ReturnType<typeof db.createClient>>()
    db.pool.connect.mockReturnValueOnce(connection.promise)
    const instance = manager(db)
    const first = instance.start()
    const completed = vi.fn()
    const second = instance.start().then(completed)
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).not.toHaveBeenCalled()
    expect(db.pool.connect).toHaveBeenCalledTimes(1)
    connection.resolve(db.createClient())
    await Promise.all([first, second])
    expect(instance.currentState).toBe('leader')
  })

  it('shares concurrent stops and delays restart until unlock finishes', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    const unlocked = deferred<{ rows: Array<{ unlocked: boolean }> }>()
    const client = db.clients[0]
    const actualQuery = client.query.getMockImplementation()!
    client.query.mockImplementationOnce(async (sql, parameters) => {
      await unlocked.promise
      return actualQuery(sql, parameters)
    })
    const first = instance.stop()
    const second = instance.stop()
    const restart = instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(db.pool.connect).toHaveBeenCalledTimes(1)
    unlocked.resolve({ rows: [{ unlocked: true }] })
    await Promise.all([first, second, restart])
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(instance.currentState).toBe('leader')
    expect(db.locks.size).toBe(1)
  })

  it('allows an acquisition observer to stop the manager without reviving heartbeat', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    instance.on({ onAcquired: () => { void instance.stop() } })
    await instance.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.currentState).toBe('standby')
    expect(vi.getTimerCount()).toBe(0)
    expect(db.locks.size).toBe(0)
  })

  it.each([1, 2_147_483_647])('accepts timer boundary %s without coercion', async interval => {
    const db = databaseDouble()
    const instance = manager(db, { retryIntervalMs: interval, heartbeatIntervalMs: interval })
    await instance.start()
    expect(instance.currentState).toBe('leader')
    expect(vi.getTimerCount()).toBe(1)
    await instance.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not reconnect after standby is stopped before the retry boundary', async () => {
    const db = databaseDouble()
    db.pool.connect.mockRejectedValueOnce(new Error('offline'))
    const instance = manager(db)
    await instance.start()
    await vi.advanceTimersByTimeAsync(99)
    await instance.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(db.pool.connect).toHaveBeenCalledTimes(1)
    expect(instance.currentState).toBe('standby')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('destroys the client on a connection error during pending acquisition', async () => {
    const db = databaseDouble()
    const client = db.createClient()
    const acquired = deferred<{ rows: Array<{ acquired: boolean }> }>()
    client.query.mockReturnValueOnce(acquired.promise)
    db.pool.connect.mockResolvedValueOnce(client)
    const instance = manager(db)
    const start = instance.start()
    await vi.advanceTimersByTimeAsync(0)
    client.emit('error', new Error('socket failed'))
    acquired.resolve({ rows: [{ acquired: true }] })
    await start
    expect(instance.currentState).toBe('standby')
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(instance.currentState).toBe('leader')
  })

  it('ignores an old pending acquisition failure after a new run becomes leader', async () => {
    const db = databaseDouble()
    const client = db.createClient()
    const acquired = deferred<{ rows: Array<{ acquired: boolean }> }>()
    client.query.mockReturnValueOnce(acquired.promise)
    db.pool.connect.mockResolvedValueOnce(client)
    const instance = manager(db)
    const onError = vi.fn()
    instance.on({ onError })
    const start = instance.start()
    await vi.advanceTimersByTimeAsync(0)
    await instance.stop()
    await instance.start()
    const newClient = db.clients[1]
    acquired.reject(new Error('stale failure'))
    await start
    expect(instance.currentState).toBe('leader')
    expect(newClient.release).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([{ rows: [] }, { rows: [{ unlocked: false }] }, { rows: [{ unlocked: 'true' }] }])('destroys the session on an unconfirmed unlock %j', async ({ rows }) => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    db.clients[0].query.mockResolvedValueOnce({ rows } as never)
    await instance.stop()
    expect(db.clients[0].release).toHaveBeenCalledExactlyOnceWith(true)
    expect(db.locks.size).toBe(0)
  })

  it('removes the client error handler and returns a healthy unlocked session', async () => {
    const db = databaseDouble()
    const instance = manager(db)
    await instance.start()
    const client = db.clients[0]
    await instance.stop()
    await instance.stop()
    expect(client.listenerCount('error')).toBe(0)
    expect(client.release).toHaveBeenCalledExactlyOnceWith()
    expect(db.locks.size).toBe(0)
  })

  it('contains non-Error rejection and reports an Error without serializing its payload', async () => {
    const db = databaseDouble()
    const log = vi.fn()
    const onError = vi.fn()
    db.pool.connect.mockRejectedValueOnce({ credential: 'private-secret' })
    const instance = manager(db, { log })
    instance.on({ onError })
    await instance.start()
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-secret')
    await vi.advanceTimersByTimeAsync(100)
    expect(instance.currentState).toBe('leader')
  })

  it('contains a pool release exception and keeps the stopped state and timers consistent', async () => {
    const db = databaseDouble()
    const log = vi.fn()
    const instance = manager(db, { log })
    await instance.start()
    db.clients[0].release.mockImplementationOnce(() => { throw new Error('release secret') })
    await instance.stop()
    expect(instance.currentState).toBe('standby')
    expect(vi.getTimerCount()).toBe(0)
    expect(db.locks.size).toBe(0)
    expect(log).toHaveBeenCalledWith('[WorkerLease] Client release failed')
    expect(JSON.stringify(log.mock.calls)).not.toContain('release secret')
  })
})
