import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { latencyBudgetMiddleware } from '../latencyBudget.js'
import { HEADER_LATENCY_BUDGET } from '../../config/constants.js'

describe('latencyBudgetMiddleware', () => {
  it('echoes the latency budget header if present', () => {
    const req = {
      header: vi.fn().mockReturnValue('1500')
    } as unknown as Request

    const res = {
      setHeader: vi.fn()
    } as unknown as Response

    const next = vi.fn() as NextFunction

    latencyBudgetMiddleware(req, res, next)

    expect(req.header).toHaveBeenCalledWith(HEADER_LATENCY_BUDGET)
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_LATENCY_BUDGET, '1500')
    expect(next).toHaveBeenCalled()
  })

  it('does not set the header if absent on the request', () => {
    const req = {
      header: vi.fn().mockReturnValue(undefined)
    } as unknown as Request

    const res = {
      setHeader: vi.fn()
    } as unknown as Response

    const next = vi.fn() as NextFunction

    latencyBudgetMiddleware(req, res, next)

    expect(req.header).toHaveBeenCalledWith(HEADER_LATENCY_BUDGET)
    expect(res.setHeader).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalled()
  })
})
