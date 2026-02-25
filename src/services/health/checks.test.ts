import { describe, it, expect } from 'vitest'
import { runHealthChecks } from './checks.js'

describe('runHealthChecks', () => {
  it('returns ok when no probes are configured (all not_configured)', async () => {
    const result = await runHealthChecks({})
    expect(result.status).toBe('ok')
    expect(result.service).toBe('credence-backend')
    expect(result.dependencies.db).toEqual({ status: 'not_configured' })
    expect(result.dependencies.redis).toEqual({ status: 'not_configured' })
    expect(result.dependencies.external).toBeUndefined()
  })

  it('returns ok when db and redis are up', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('ok')
    expect(result.dependencies.db).toEqual({ status: 'up' })
    expect(result.dependencies.redis).toEqual({ status: 'up' })
  })

  it('returns unhealthy and 503 when db is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.db).toEqual({ status: 'down' })
    expect(result.dependencies.redis).toEqual({ status: 'up' })
  })

  it('returns unhealthy when redis is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.redis).toEqual({ status: 'down' })
  })

  it('returns unhealthy when both db and redis are down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
  })

  it('returns degraded (not unhealthy) when only external is down', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      external: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('degraded')
    expect(result.dependencies.external).toEqual({ status: 'down' })
  })

  it('returns ok when external is up', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'up' }),
      redis: async () => ({ status: 'up' }),
      external: async () => ({ status: 'up' }),
    })
    expect(result.status).toBe('ok')
    expect(result.dependencies.external).toEqual({ status: 'up' })
  })

  it('does not expose internal details in response', async () => {
    const result = await runHealthChecks({
      db: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'down' }),
    })
    const body = JSON.stringify(result)
    expect(body).not.toMatch(/error|message|stack|connection|url|host/i)
    expect(result.dependencies.db).toEqual({ status: 'down' })
    expect(Object.keys(result.dependencies.db)).toEqual(['status'])
  })
})
