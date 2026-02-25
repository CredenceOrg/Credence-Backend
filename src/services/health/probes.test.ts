import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createDbProbe,
  createRedisProbe,
  createDefaultProbes,
  createExternalProbe,
} from './probes.js'

// Mock pg so createDbProbe() real path returns up without a real DB
vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = () => Promise.resolve({ rows: [] })
    },
  },
}))

// Mock ioredis so createRedisProbe() real path returns up without a real Redis
vi.mock('ioredis', () => ({
  default: class {
    ping = () => Promise.resolve('PONG')
  },
}))

describe('createDefaultProbes', () => {
  let savedDbUrl: string | undefined
  let savedRedisUrl: string | undefined

  beforeEach(() => {
    savedDbUrl = process.env.DATABASE_URL
    savedRedisUrl = process.env.REDIS_URL
    delete process.env.DATABASE_URL
    delete process.env.REDIS_URL
  })

  afterEach(() => {
    if (savedDbUrl !== undefined) process.env.DATABASE_URL = savedDbUrl
    else delete process.env.DATABASE_URL
    if (savedRedisUrl !== undefined) process.env.REDIS_URL = savedRedisUrl
    else delete process.env.REDIS_URL
  })

  it('returns no db/redis probes when env vars are unset', () => {
    const probes = createDefaultProbes()
    expect(probes.db).toBeUndefined()
    expect(probes.redis).toBeUndefined()
    expect(probes.external).toBeUndefined()
  })

  it('returns db probe when DATABASE_URL is set', () => {
    process.env.DATABASE_URL = 'postgres://localhost/db'
    const probes = createDefaultProbes()
    expect(probes.db).toBeDefined()
    expect(typeof probes.db).toBe('function')
  })

  it('returns redis probe when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost'
    const probes = createDefaultProbes()
    expect(probes.redis).toBeDefined()
    expect(typeof probes.redis).toBe('function')
  })
})

describe('createExternalProbe', () => {
  it('returns up when check resolves to true', async () => {
    const probe = createExternalProbe(async () => true)
    const result = await probe()
    expect(result).toEqual({ status: 'up' })
  })

  it('returns down when check resolves to false', async () => {
    const probe = createExternalProbe(async () => false)
    const result = await probe()
    expect(result).toEqual({ status: 'down' })
  })

  it('returns down when check throws', async () => {
    const probe = createExternalProbe(async () => {
      throw new Error('network error')
    })
    const result = await probe()
    expect(result).toEqual({ status: 'down' })
  })
})

describe('createDbProbe', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL
  })

  it('returns undefined when DATABASE_URL is unset and no options', () => {
    expect(createDbProbe()).toBeUndefined()
  })

  it('returns up when runQuery option succeeds', async () => {
    const probe = createDbProbe({ runQuery: async () => undefined })
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'up' })
  })

  it('returns down when runQuery option throws', async () => {
    const probe = createDbProbe({
      runQuery: async () => {
        throw new Error('connection refused')
      },
    })
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'down' })
  })
})

describe('createRedisProbe', () => {
  afterEach(() => {
    delete process.env.REDIS_URL
  })

  it('returns undefined when REDIS_URL is unset and no options', () => {
    expect(createRedisProbe()).toBeUndefined()
  })

  it('returns up when ping option succeeds', async () => {
    const probe = createRedisProbe({ ping: async () => 'PONG' })
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'up' })
  })

  it('returns down when ping option throws', async () => {
    const probe = createRedisProbe({
      ping: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'down' })
  })
})

describe('createDbProbe with real pg path (mocked)', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://localhost/test'
  })
  afterEach(() => {
    delete process.env.DATABASE_URL
  })

  it('returns probe when DATABASE_URL is set', () => {
    const probe = createDbProbe()
    expect(probe).toBeDefined()
  })

  it('returns up when using real pg path with mocked pg', async () => {
    const probe = createDbProbe()
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'up' })
  })
})

describe('createRedisProbe with real redis path (mocked)', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost'
  })
  afterEach(() => {
    delete process.env.REDIS_URL
  })

  it('returns probe when REDIS_URL is set', () => {
    const probe = createRedisProbe()
    expect(probe).toBeDefined()
  })

  it('returns up when using real redis path with mocked ioredis', async () => {
    const probe = createRedisProbe()
    expect(probe).toBeDefined()
    const result = await probe!()
    expect(result).toEqual({ status: 'up' })
  })
})
