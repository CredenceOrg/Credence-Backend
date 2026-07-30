import type { NextFunction, Request, Response } from 'express'

export interface RequestMetrics {
  increment(name: string, amount?: number): number
  inc(name: string, amount?: number): number
  get(name: string): number
  snapshot(): Record<string, number>
  reset(): void
}

function validateCounterName(name: string): void {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new TypeError('Metric name must be a non-empty string')
  }
}

function validateAmount(amount: number): void {
  if (!Number.isFinite(amount)) {
    throw new TypeError('Metric increment must be a finite number')
  }
}

export function createRequestMetrics(): RequestMetrics {
  const counters = new Map<string, number>()

  const increment = (name: string, amount = 1): number => {
    validateCounterName(name)
    validateAmount(amount)

    const nextValue = (counters.get(name) ?? 0) + amount
    counters.set(name, nextValue)
    return nextValue
  }

  return {
    increment,
    inc: increment,
    get(name: string): number {
      validateCounterName(name)
      return counters.get(name) ?? 0
    },
    snapshot(): Record<string, number> {
      return Object.fromEntries(counters)
    },
    reset(): void {
      counters.clear()
    },
  }
}

export function requestMetrics(req: Request, _res: Response, next: NextFunction): void {
  req.metrics = createRequestMetrics()
  next()
}

export const requestMetricsMiddleware = requestMetrics

declare global {
  namespace Express {
    interface Request {
      metrics: RequestMetrics
    }
  }
}
