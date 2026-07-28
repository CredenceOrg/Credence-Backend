import { describe, expect, it, vi } from 'vitest'
import type { Request, Response } from 'express'
import { createRequestMetrics, requestMetrics } from './requestMetrics.js'

describe('request metrics shim', () => {
  it('keeps counters isolated per request', () => {
    const first = createRequestMetrics()
    const second = createRequestMetrics()

    expect(first.increment('cache.hit')).toBe(1)
    expect(first.inc('cache.hit', 2)).toBe(3)
    expect(first.get('cache.hit')).toBe(3)
    expect(second.get('cache.hit')).toBe(0)
  })

  it('returns a copy of the current counters', () => {
    const metrics = createRequestMetrics()
    metrics.increment('db.query', 2)

    const snapshot = metrics.snapshot()
    snapshot['db.query'] = 99

    expect(metrics.get('db.query')).toBe(2)
  })

  it('resets only the current request counters', () => {
    const metrics = createRequestMetrics()
    metrics.increment('handler.invoked')

    metrics.reset()

    expect(metrics.snapshot()).toEqual({})
  })

  it('initializes req.metrics and calls next', () => {
    const req = {} as Request
    const next = vi.fn()

    requestMetrics(req, {} as Response, next)

    req.metrics.increment('handler.invoked')
    expect(req.metrics.get('handler.invoked')).toBe(1)
    expect(next).toHaveBeenCalledOnce()
  })

  it('rejects invalid counter names and amounts', () => {
    const metrics = createRequestMetrics()

    expect(() => metrics.increment('')).toThrow('Metric name must be a non-empty string')
    expect(() => metrics.increment('invalid', Number.NaN)).toThrow('Metric increment must be a finite number')
  })
})
