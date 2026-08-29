import type { Request, Response, NextFunction } from 'express'
import { HEADER_LATENCY_BUDGET } from '../config/constants.js'

export function latencyBudgetMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const budget = req.header(HEADER_LATENCY_BUDGET)
  if (budget !== undefined) {
    res.setHeader(HEADER_LATENCY_BUDGET, budget)
  }
  next()
}
