import { describe, it, expect } from 'vitest'
import { runHealthChecks } from './checks.js'

describe('runHealthChecks', () => {
  it('returns ok when no probes are configured (all not_configured)', async () => {
    const result = await runHealthChecks({})
    expect(result.status).toBe('ok')
    expect(result.service).toBe('credence-backend')
    expect(result.dependencies.db).toEqual({ status: 'not_configured' })
    expect(result.dependencies.cache).toEqual({ status: 'not_configured' })
    expect(result.dependencies.queue).toEqual({ status: 'not_configured' })
    expect(result.dependencies.gateway).toEqual({ status: 'not_configured' })
  })

  it('returns ok when db, cache, and queue are up', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
      queue: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('ok')
    expect(result.dependencies.db).toEqual({ status: 'up' })
    expect(result.dependencies.cache).toEqual({ status: 'up' })
    expect(result.dependencies.queue).toEqual({ status: 'up' })
  })

  it('returns unhealthy and 503 when db is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'down' }),
      cache: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.db).toEqual({ status: 'down' })
    expect(result.dependencies.cache).toEqual({ status: 'up' })
  })

  it('returns unhealthy when cache is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.cache).toEqual({ status: 'down' })
  })

  it('returns unhealthy when queue is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
      queue: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.queue).toEqual({ status: 'down' })
  })

  it('returns degraded (not unhealthy) when gateway is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
      queue: async () => ({ status: 'up' }),
      gateway: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('degraded')
    expect(result.dependencies.gateway).toEqual({ status: 'down' })
  })

  it('returns ok when gateway is up', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      cache: async () => ({ status: 'up' }),
      gateway: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('ok')
    expect(result.dependencies.gateway).toEqual({ status: 'up' })
  })

  it('does not expose internal details in response', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'down' }),
      cache: async () => ({ status: 'down' }),
    })
    const body = JSON.stringify(result)
    expect(body).not.toMatch(/error|message|stack|connection|url|host/i)
    expect(result.dependencies.db).toEqual({ status: 'down' })
    expect(Object.keys(result.dependencies.db)).toEqual(['status'])
  })
})
