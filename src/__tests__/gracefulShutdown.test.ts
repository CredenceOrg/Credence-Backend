import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { setReady, isReady } from '../lifecycle.js'
import { createHealthRouter } from '../routes/health.js'
import { GracefulShutdownManager } from '../gracefulShutdown.js'

describe('GracefulShutdownManager', () => {
  beforeEach(() => {
    setReady(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('marks readiness false and exits cleanly after server close and workers stop', async () => {
    const close = vi.fn((callback: (err?: Error | null) => void) => callback())
    const fakeServer = { close } as unknown as import('http').Server
    const stopOutbox = vi.fn(async () => undefined)
    const stopScheduler = vi.fn(() => undefined)
    const forceExit = vi.fn()
    const logger = vi.fn()

    const manager = new GracefulShutdownManager({
      server: fakeServer,
      outboxJob: { stop: stopOutbox },
      scheduler: { stop: stopScheduler },
      gracePeriodMs: 1000,
      forceExit,
      logger,
    })

    expect(isReady()).toBe(true)
    await manager.shutdown('SIGTERM')

    expect(close).toHaveBeenCalledOnce()
    expect(stopOutbox).toHaveBeenCalledOnce()
    expect(stopScheduler).toHaveBeenCalledOnce()
    expect(isReady()).toBe(false)
    expect(forceExit).toHaveBeenCalledWith(0)
    expect(logger).toHaveBeenCalledWith('[Shutdown] Graceful shutdown complete.')
  })

  it('calls forceExit immediately when shutdown is already in progress', async () => {
    const close = vi.fn((callback: (err?: Error | null) => void) => callback())
    const fakeServer = { close } as unknown as import('http').Server
    const forceExit = vi.fn()

    const manager = new GracefulShutdownManager({
      server: fakeServer,
      gracePeriodMs: 1000,
      forceExit,
      logger: vi.fn(),
    })

    await manager.shutdown('SIGTERM')
    await manager.shutdown('SIGTERM')

    expect(forceExit).toHaveBeenLastCalledWith(1)
  })

  it('force exits after the grace period when server close takes too long', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const fakeServer = { close } as unknown as import('http').Server
    const forceExit = vi.fn()
    const logger = vi.fn()

    const manager = new GracefulShutdownManager({
      server: fakeServer,
      gracePeriodMs: 100,
      forceExit,
      logger,
    })

    void manager.shutdown('SIGTERM')
    vi.advanceTimersByTime(150)

    expect(forceExit).toHaveBeenCalledWith(1)
    vi.useRealTimers()
  })
})

describe('Health router readiness during shutdown', () => {
  afterEach(() => {
    setReady(true)
  })

  it('returns 503 when readiness is false even if dependencies are healthy', async () => {
    setReady(false)
    const app = express()
    app.use(
      '/api/health',
      createHealthRouter({
        db: async () => ({ status: 'up' }),
        cache: async () => ({ status: 'up' }),
        queue: async () => ({ status: 'up' }),
        isReady: isReady,
      }),
    )

    const response = await request(app).get('/api/health')
    expect(response.status).toBe(503)
    expect(response.body.status).toBe('unhealthy')
  })
})
