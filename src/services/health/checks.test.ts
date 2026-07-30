import { describe, it, expect } from 'vitest'
import { runHealthChecks, CRITICAL_DEPS } from './checks.js'

const allUp = {
  postgres: async () => ({ status: 'up' as const }),
  redis: async () => ({ status: 'up' as const }),
  horizonListener: async () => ({ status: 'up' as const }),
  outboxPublisher: async () => ({ status: 'up' as const }),
  horizon: async () => ({ status: 'up' as const }),
  keyManager: async () => ({ status: 'up' as const }),
  kek: async () => ({ status: 'up' as const }),
}

describe('runHealthChecks', () => {
  // ── Fail-closed: critical deps not_configured → unhealthy ────────────────

  it('returns unhealthy when no probes are configured (critical deps are not_configured)', async () => {
    const result = await runHealthChecks({})
    // postgres, redis, horizonListener are critical → unhealthy, not degraded
    expect(result.status).toBe('unhealthy')
    expect(result.service).toBe('credence-backend')
    expect(result.dependencies.postgres).toEqual({ status: 'not_configured' })
    expect(result.dependencies.redis).toEqual({ status: 'not_configured' })
    expect(result.dependencies.horizonListener).toEqual({ status: 'not_configured' })
    expect(result.dependencies.outboxPublisher).toEqual({ status: 'not_configured' })
    expect(result.dependencies.horizon).toEqual({ status: 'not_configured' })
  })

  it('returns unhealthy when postgres is not_configured (fail-closed)', async () => {
    const result = await runHealthChecks({
      ...allUp,
      postgres: async () => ({ status: 'not_configured' as const }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.postgres).toEqual({ status: 'not_configured' })
  })

  it('returns unhealthy when redis is not_configured (fail-closed)', async () => {
    const result = await runHealthChecks({
      ...allUp,
      redis: async () => ({ status: 'not_configured' as const }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.redis).toEqual({ status: 'not_configured' })
  })

  it('returns unhealthy when horizonListener is not_configured (fail-closed)', async () => {
    const result = await runHealthChecks({
      ...allUp,
      horizonListener: async () => ({ status: 'not_configured' as const }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.horizonListener).toEqual({ status: 'not_configured' })
  })

  it('critical not_configured deps appear in degradation.criticalDown', async () => {
    const result = await runHealthChecks({
      ...allUp,
      postgres: async () => ({ status: 'not_configured' as const }),
    })
    expect(result.degradation?.criticalDown).toContain('postgres')
    expect(result.degradation?.notConfigured).toContain('postgres')
    expect(result.degradation?.reasons).toEqual(
      expect.arrayContaining([{ dep: 'postgres', reason: 'not_configured' }]),
    )
  })

  // ── Degraded: only non-critical deps not_configured → degraded ──────────

  it('returns degraded (not unhealthy) when only non-critical deps are not_configured', async () => {
    const result = await runHealthChecks({
      ...allUp,
      horizon: async () => ({ status: 'not_configured' as const }),
    })
    expect(result.status).toBe('degraded')
    expect(result.dependencies.horizon).toEqual({ status: 'not_configured' })
  })

  // ── Normal down/up paths ─────────────────────────────────────────────────

  it('returns ok when all dependencies are up', async () => {
    const result = await runHealthChecks(allUp)
    expect(result.status).toBe('ok')
    expect(result.dependencies.horizon).toEqual({ status: 'up' })
  })

  it('returns unhealthy when postgres is down', async () => {
    const result = await runHealthChecks({
      ...allUp,
      postgres: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.postgres).toEqual({ status: 'down' })
  })

  it('returns unhealthy when redis is down', async () => {
    const result = await runHealthChecks({
      ...allUp,
      redis: async () => ({ status: 'down' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.redis).toEqual({ status: 'down' })
  })

  it('returns unhealthy when horizon listener is down', async () => {
    const result = await runHealthChecks({
      ...allUp,
      horizonListener: async () => ({ status: 'down', reason: 'stale_heartbeat' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.horizonListener).toEqual({ status: 'down', reason: 'stale_heartbeat' })
  })

  it('returns unhealthy when outbox publisher is down', async () => {
    const result = await runHealthChecks({
      ...allUp,
      outboxPublisher: async () => ({ status: 'down', reason: 'not_running' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.outboxPublisher).toEqual({ status: 'down', reason: 'not_running' })
  })

  it('returns unhealthy when horizon circuit breaker is open', async () => {
    const result = await runHealthChecks({
      ...allUp,
      horizon: async () => ({ status: 'down', reason: 'circuit_open' }),
    })
    expect(result.status).toBe('unhealthy')
    expect(result.dependencies.horizon).toEqual({ status: 'down', reason: 'circuit_open' })
  })

  it('includes latencyMs when probe returns it', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'up', latencyMs: 5 }),
      redis: async () => ({ status: 'up', latencyMs: 3 }),
      horizonListener: async () => ({ status: 'up', latencyMs: 1 }),
      outboxPublisher: async () => ({ status: 'up', latencyMs: 2 }),
      horizon: async () => ({ status: 'up', latencyMs: 4 }),
    })
    expect(result.dependencies.postgres.latencyMs).toBe(5)
    expect(result.dependencies.redis.latencyMs).toBe(3)
    expect(result.dependencies.horizon.latencyMs).toBe(4)
  })

  it('does not expose internal details in response', async () => {
    const result = await runHealthChecks({
      postgres: async () => ({ status: 'down' }),
      redis: async () => ({ status: 'down' }),
      horizonListener: async () => ({ status: 'down' }),
      outboxPublisher: async () => ({ status: 'down' }),
      horizon: async () => ({ status: 'down' }),
      keyManager: async () => ({ status: 'down' }),
      kek: async () => ({ status: 'down' }),
    })
    const body = JSON.stringify(result)
    // Ensure no internal error messages, stack traces, or connection details leak.
    // We intentionally do NOT match on "error" here because that is a valid
    // DependencyReason code ("error") emitted by probes; it is not a leak.
    expect(body).not.toMatch(/message|stack|connection string|url|host/i)
    expect(result.dependencies.postgres).toEqual({ status: 'down' })
    expect(Object.keys(result.dependencies.postgres)).toEqual(['status'])
  })

  // ── CRITICAL_DEPS export sanity check ────────────────────────────────────

  it('CRITICAL_DEPS contains exactly postgres, redis, horizonListener', () => {
    expect(CRITICAL_DEPS.has('postgres')).toBe(true)
    expect(CRITICAL_DEPS.has('redis')).toBe(true)
    expect(CRITICAL_DEPS.has('horizonListener')).toBe(true)
    expect(CRITICAL_DEPS.size).toBe(3)
  })
})
