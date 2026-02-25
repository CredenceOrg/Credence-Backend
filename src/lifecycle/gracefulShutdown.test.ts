import { describe, expect, it, vi } from 'vitest'
import {
  createGracefulShutdownManager,
  createRequestTracker,
  type RequestTracker,
} from './gracefulShutdown.js'

describe('createRequestTracker', () => {
  it('tracks in-flight requests and decrements on finish', () => {
    const tracker = createRequestTracker()
    const req = {} as any
    const listeners: Record<string, () => void> = {}
    const res = {
      once: (event: string, handler: () => void) => {
        listeners[event] = handler
      },
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as any
    const next = vi.fn()

    tracker.middleware(req, res, next)
    expect(tracker.getInFlight()).toBe(1)
    listeners.finish()
    expect(tracker.getInFlight()).toBe(0)
  })

  it('rejects new requests while draining', () => {
    const tracker = createRequestTracker()
    tracker.setDraining(true)

    const req = {} as any
    const res = {
      once: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as any
    const next = vi.fn()

    tracker.middleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('createGracefulShutdownManager', () => {
  it('runs shutdown sequence and exits with code 0', async () => {
    const tracker: RequestTracker = {
      middleware: vi.fn() as any,
      getInFlight: vi.fn().mockReturnValue(0),
      setDraining: vi.fn(),
    }
    const server = {
      close: vi.fn((cb: () => void) => cb()),
    }
    const closeDb = vi.fn().mockResolvedValue(undefined)
    const closeRedis = vi.fn().mockResolvedValue(undefined)
    const exitFn = vi.fn()

    const manager = createGracefulShutdownManager({
      server,
      timeoutMs: 5000,
      tracker,
      resources: [
        { name: 'db', close: closeDb },
        { name: 'redis', close: closeRedis },
      ],
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      exitFn,
    })

    await manager.shutdown('SIGTERM')
    expect(server.close).toHaveBeenCalledOnce()
    expect(closeDb).toHaveBeenCalledOnce()
    expect(closeRedis).toHaveBeenCalledOnce()
    expect(exitFn).toHaveBeenCalledWith(0)
  })

  it('forces exit 1 on timeout', async () => {
    vi.useFakeTimers()
    const tracker: RequestTracker = {
      middleware: vi.fn() as any,
      getInFlight: vi.fn().mockReturnValue(1),
      setDraining: vi.fn(),
    }
    const server = {
      close: vi.fn((cb: () => void) => cb()),
    }
    const exitFn = vi.fn()
    const manager = createGracefulShutdownManager({
      server,
      timeoutMs: 10,
      tracker,
      resources: [],
      logger: {
        info: vi.fn(),
        error: vi.fn(),
      },
      exitFn,
    })

    const shutdownPromise = manager.shutdown('SIGINT')
    await vi.advanceTimersByTimeAsync(20)
    await shutdownPromise

    expect(exitFn).toHaveBeenCalledWith(1)
    vi.useRealTimers()
  })
})
